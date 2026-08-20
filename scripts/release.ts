// sapwood release script — `npm run release -- <prepare|publish|stamp> ...`.
// Node built-ins + `git`/`gh`/`npm` via child_process only, no dependency. Plain Node 24
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

// Not one of the four version-carrying manifests (it has no "version" field of its own) — its
// plugins[0].source.ref is a DERIVED carrier, same relationship package-lock.json has to the
// four: written only as a side effect of a prepare bump, never hand-edited. "main" is the
// pre-first-release placeholder (see marketplaceRefFor below); once a version ships, ref must
// equal that tag for the marketplace's `npx sapwood@<version>` pin to resolve the version the
// slash commands actually invoked. The committed file's bytes are the exact
// `JSON.stringify(data, null, 2) + "\n"` canonical form writeMarketplaceFile below produces, so
// every rewrite stays a minimal one-line diff instead of reformatting the whole file.
export const MARKETPLACE_PATH = ".claude-plugin/marketplace.json";

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

export interface ParsedSemver {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
}

// major/minor/patch stay strings, same as the prerelease identifiers below — `compareSemver`
// runs them through the identical length-then-lexical numeric compare rather than `Number()`,
// so a 20-digit major component orders correctly instead of silently losing precision.
export function parseSemver(version: string): ParsedSemver {
  const m = SEMVER_RE.exec(version);
  if (!m) throw new Error(`"${version}" is not a valid SemVer 2.0.0 version`);
  const [, major, minor, patch, prerelease] = m;
  // major/minor/patch are required (non-optional) capture groups in SEMVER_RE, so a
  // successful match always populates them — the `!`s tell noUncheckedIndexedAccess
  // what the regex grammar already guarantees.
  return { major: major!, minor: minor!, patch: patch!, prerelease: prerelease ? prerelease.split(".") : [] };
}

// SemVer 2.0.0 §11 precedence: numeric identifiers compare numerically, alphanumeric
// identifiers lexically (ASCII), a numeric identifier always has lower precedence than an
// alphanumeric one, and a larger set of pre-release fields wins once every shared field ties.
// Numeric identifiers compare by LENGTH first, then lexically — never via `Number()`, which
// silently loses precision past 2^53 and would misorder a pre-release field with enough digits.
// The grammar above already forbids leading zeros on a numeric identifier, so equal-length
// numeric strings compare correctly by ordinary string comparison.
function compareIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// A pre-release version has lower precedence than the release it precedes
// (`0.3.0-alpha.1` < `0.3.0`) — the one asymmetry the field-by-field comparison above can't
// express on its own, since an absent prerelease field isn't a shorter list, it's a different rank.
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  // major/minor/patch are guaranteed all-digit by SEMVER_RE's grammar, so compareIdentifier's
  // numeric branch always applies here — the same length-then-lexical rule the prerelease loop
  // below uses, not a second numeric-compare implementation.
  const majorCmp = compareIdentifier(pa.major, pb.major);
  if (majorCmp !== 0) return majorCmp;
  const minorCmp = compareIdentifier(pa.minor, pb.minor);
  if (minorCmp !== 0) return minorCmp;
  const patchCmp = compareIdentifier(pa.patch, pb.patch);
  if (patchCmp !== 0) return patchCmp;
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const len = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    // i < len <= both arrays' lengths, so both indices are always in bounds.
    const c = compareIdentifier(pa.prerelease[i]!, pb.prerelease[i]!);
    if (c !== 0) return c;
  }
  return pa.prerelease.length - pb.prerelease.length;
}

// ── Manifest lockstep ───────────────────────────────────────────────────────────────

export function readManifestVersion(path: string): string {
  const text = readFileSync(path, "utf8");
  const m = text.match(/"version"\s*:\s*"([^"]*)"/);
  if (!m) throw new Error(`no "version" field found in ${path}`);
  return m[1]!; // the capture group always matches once `m` is non-null
}

// Edits the `"version"` line's value in place instead of JSON.parse + stringify, so a
// manifest's existing formatting/indentation/key order is untouched by the bump.
export function writeManifestVersion(path: string, version: string): void {
  const text = readFileSync(path, "utf8");
  const re = /("version"\s*:\s*")([^"]*)(")/;
  if (!re.test(text)) throw new Error(`no "version" field found in ${path}`);
  writeFileSync(path, text.replace(re, `$1${version}$3`));
}

// "main" is the pre-first-release value (nothing has been tagged yet, so there is no `v<version>`
// ref to point at); everything from the first prepare onward pins to the tag prepare is about to
// cut, matching the tag `PUBLISH_STEPS`'s "tag" step creates.
export function marketplaceRefFor(version: string): string {
  return version === "0.0.0" ? "main" : `v${version}`;
}

// Unlike the four manifests' bare `"version"` line, `"ref"` is not a key `marketplace.json`
// carries only once — a source object can legitimately have sibling fields, and a future
// multi-plugin entry could carry its own `"ref"` elsewhere in the file. A text-regex rewrite (the
// approach `writeManifestVersion` uses, safe there because `"version"` really is unique per
// manifest) risks touching the wrong occurrence, so this walks the parsed structure to
// `plugins[0].source.ref` specifically instead of pattern-matching the raw text.
interface MarketplaceSource {
  ref?: string;
  [key: string]: unknown;
}
interface MarketplacePlugin {
  source: MarketplaceSource | string;
  [key: string]: unknown;
}
interface MarketplaceFile {
  plugins: MarketplacePlugin[];
  [key: string]: unknown;
}

function readMarketplaceFile(path: string): MarketplaceFile {
  return JSON.parse(readFileSync(path, "utf8"));
}

// `JSON.stringify(data, null, 2) + "\n"` is the canonical on-disk form the committed
// marketplace.json is written to match exactly — see MARKETPLACE_PATH's own comment — so a
// rewrite here is always a minimal, one-line diff on `ref`, never a reformat of the whole file.
function writeMarketplaceFile(path: string, data: MarketplaceFile): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function marketplaceSourceObject(data: MarketplaceFile, path: string): MarketplaceSource {
  const source = data.plugins[0]?.source;
  if (typeof source !== "object" || source === null) {
    throw new Error(`no plugins[0].source object found in ${path}`);
  }
  return source;
}

// Edits only `plugins[0].source.ref`'s value, mirroring `writeManifestVersion`'s "touch one
// field, leave everything else alone" contract — but structurally, so a `"ref"` string anywhere
// else in the file (a sibling plugin, a differently-shaped source) is never at risk of being hit.
export function writeMarketplaceRef(path: string, ref: string): void {
  const data = readMarketplaceFile(path);
  marketplaceSourceObject(data, path).ref = ref;
  writeMarketplaceFile(path, data);
}

export function readMarketplaceRef(path: string): string {
  const data = readMarketplaceFile(path);
  const ref = marketplaceSourceObject(data, path).ref;
  if (typeof ref !== "string") throw new Error(`no plugins[0].source.ref field found in ${path}`);
  return ref;
}

export type MarketplaceRefCheckResult = { ok: true } | { ok: false; message: string };

// Lockstep's marketplace half: at "0.0.0" (nothing shipped yet) any ref is accepted — there is no
// tag to point at, and `runPrepare` hasn't rewritten it for the version about to be cut. Once a
// version is set, the ref must equal marketplaceRefFor(version) exactly, the same way the four
// manifests and the lockfile must equal it.
export function checkMarketplaceRef(marketplacePath: string, version: string): MarketplaceRefCheckResult {
  if (version === "0.0.0") return { ok: true };
  const ref = readMarketplaceRef(marketplacePath);
  const expected = marketplaceRefFor(version);
  if (ref !== expected) {
    return { ok: false, message: `${marketplacePath}'s plugins[0].source.ref is "${ref}", expected "${expected}" for version ${version}.` };
  }
  return { ok: true };
}

export type LockstepResult = { ok: true; version: string } | { ok: false; message: string };

export function checkManifestLockstep(paths: string[]): LockstepResult {
  const versions = paths.map((path) => ({ path, version: readManifestVersion(path) }));
  const first = versions[0];
  if (!first) return { ok: false, message: "no manifest paths given" };
  const mismatched = versions.filter((v) => v.version !== first.version);
  if (mismatched.length > 0) {
    return { ok: false, message: `manifest versions disagree: ${versions.map((v) => `${v.path}=${v.version}`).join(", ")}` };
  }
  return { ok: true, version: first.version };
}

// `package-lock.json` is not a fifth place a human (or this script) sets a version — its
// root/`engine`/`dashboard` `packages[...]` entries are DERIVED from the four manifests by
// `npm install --package-lock-only` (see `runPrepare`), so this only ever reads them back to
// confirm that derivation actually landed, never writes them directly.
const LOCKFILE_PACKAGE_KEYS = ["", "engine", "dashboard"];

export type LockfileCheckResult = { ok: true } | { ok: false; message: string };

export function checkLockfileVersions(repoRoot: string, version: string): LockfileCheckResult {
  const lockPath = join(repoRoot, "package-lock.json");
  let lock: { version?: string; packages?: Record<string, { version?: string }> };
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (e) {
    return { ok: false, message: `package-lock.json could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
  const packages = lock.packages ?? {};
  // The lockfile's OWN top-level "version" (line 3 of a fresh `npm install` output) is a
  // fourth place it states a version, distinct from the three `packages[...]` entries below —
  // `npm install --package-lock-only` sets both, so both are checked, not just the entries.
  const entries: Array<{ label: string; actual: string | undefined }> = [
    { label: "(top-level)", actual: lock.version },
    ...LOCKFILE_PACKAGE_KEYS.map((key) => ({ label: key === "" ? "(root)" : key, actual: packages[key]?.version })),
  ];
  const mismatched = entries.filter((e) => e.actual !== version);
  if (mismatched.length > 0) {
    const found = mismatched.map((e) => `${e.label}=${e.actual ?? "missing"}`).join(", ");
    return { ok: false, message: `package-lock.json disagrees with version ${version}: ${found}` };
  }
  return { ok: true };
}

// ── CHANGELOG ────────────────────────────────────────────────────────────────────────
// Headings are recognized only when they begin a line (never inside prose, an inline code
// span, or an indented example) so a stray "## [Unreleased]" mentioned in passing elsewhere
// in the file can never be mistaken for the real section marker. Input is normalized to LF
// first so a CRLF-saved file (a Windows editor, a stray `git config core.autocrlf`) still
// matches — every heading offset downstream is computed against the normalized text.

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `[ \t]*$` (not `\s*$`): `\s` matches `\n` too, so a greedy `\s*` would swallow the blank
// line separator that follows a heading and throw off every downstream offset.
const UNRELEASED_HEADING_RE = /^## \[Unreleased\][ \t]*$/m;

function versionHeadingRe(version: string): RegExp {
  return new RegExp(`^## \\[${escapeRegExp(version)}\\]`, "m");
}

function nextHeadingIndex(text: string, fromIndex: number): number {
  const m = /^## /m.exec(text.slice(fromIndex));
  return m ? fromIndex + m.index : -1;
}

function sectionBody(text: string, headingIndex: number, headingMatchLength: number): { body: string; nextIdx: number } {
  const afterHeading = headingIndex + headingMatchLength;
  const lineEnd = text.indexOf("\n", afterHeading);
  const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1;
  const nextIdx = nextHeadingIndex(text, bodyStart);
  const body = nextIdx === -1 ? text.slice(bodyStart) : text.slice(bodyStart, nextIdx);
  return { body: body.replace(/^\s+|\s+$/g, ""), nextIdx };
}

export function extractUnreleasedBody(changelog: string): string {
  const text = normalizeNewlines(changelog);
  const m = UNRELEASED_HEADING_RE.exec(text);
  if (!m) throw new Error(`CHANGELOG.md has no "${UNRELEASED_HEADING}" heading (it must begin its own line)`);
  return sectionBody(text, m.index, m[0].length).body;
}

export function formatChangelogVersionHeading(version: string, date: string): string {
  return `## [${version}] - ${date}`;
}

// Moves the current Unreleased body under a new `## [<version>] - <date>` heading and
// leaves a fresh, empty Unreleased section above it — everything else in the file
// (older version sections) is passed through unchanged.
export function moveUnreleasedToVersion(changelog: string, version: string, date: string): string {
  const text = normalizeNewlines(changelog);
  const m = UNRELEASED_HEADING_RE.exec(text);
  if (!m) throw new Error(`CHANGELOG.md has no "${UNRELEASED_HEADING}" heading (it must begin its own line)`);
  const { body, nextIdx } = sectionBody(text, m.index, m[0].length);
  const before = text.slice(0, m.index);
  const after = nextIdx === -1 ? "" : text.slice(nextIdx);
  const replacement = `${UNRELEASED_HEADING}\n\n${formatChangelogVersionHeading(version, date)}\n\n${body}\n\n`;
  return `${before}${replacement}${after}`;
}

export function extractVersionSection(changelog: string, version: string): string | null {
  const text = normalizeNewlines(changelog);
  const m = versionHeadingRe(version).exec(text);
  if (!m) return null;
  return sectionBody(text, m.index, m[0].length).body;
}

// Lockstep test's other half (docs/dev-guide/10-releasing.md): "0.0.0" is the
// never-yet-released state, where Unreleased is the section of record.
export function changelogHasSection(changelog: string, version: string): boolean {
  const text = normalizeNewlines(changelog);
  return version === "0.0.0" ? UNRELEASED_HEADING_RE.test(text) : versionHeadingRe(version).test(text);
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

// ── shared precondition: HEAD must be exactly origin/main ──────────────────────────
// Both `prepare` (branches from it) and `publish` (tags it) need this same freshness
// check, so it lives once here rather than as two copies that could drift apart.

export type HeadCheckResult = { ok: true } | { ok: false; reason: string };

export function checkHeadMatchesOriginMain(deps: Deps): HeadCheckResult {
  deps.exec("git", ["fetch", "origin", "main"]);
  const head = deps.exec("git", ["rev-parse", "HEAD"]).trim();
  const mainHead = deps.exec("git", ["rev-parse", "origin/main"]).trim();
  if (head !== mainHead) {
    return { ok: false, reason: `HEAD (${head}) is not origin/main (${mainHead})` };
  }
  return { ok: true };
}

// ── tag existence: local ref cache + the actual remote ──────────────────────────────
// A local `git tag -l` only ever proves a tag doesn't exist here — the deciding question is
// whether `origin` has it. `git ls-remote --exit-code` answers that without a local fetch:
// exit 0 = at least one matching ref (tag exists), exit 2 = no matching ref (definitively
// absent), anything else = a real error (network, auth) that must not be read as "absent".
// `execFileSync` communicates a non-zero exit by throwing, so the exit code arrives on the
// thrown error's `.status`, never as a return value.

function isExecExitStatus(e: unknown, status: number): boolean {
  return typeof e === "object" && e !== null && "status" in e && (e as { status?: unknown }).status === status;
}

function tagExistsOnRemote(deps: Deps, tag: string): boolean {
  try {
    deps.exec("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`]);
    return true;
  } catch (e) {
    if (isExecExitStatus(e, 2)) return false;
    throw e;
  }
}

export function checkTagExists(deps: Deps, tag: string): boolean {
  if (deps.exec("git", ["tag", "-l", tag]).trim() !== "") return true;
  return tagExistsOnRemote(deps, tag);
}

// ── publish preconditions ───────────────────────────────────────────────────────────

export type PublishPrecondition = { ok: true; version: string } | { ok: false; reason: string };

export function checkPublishPreconditions(deps: Deps): PublishPrecondition {
  const headCheck = checkHeadMatchesOriginMain(deps);
  if (!headCheck.ok) {
    return { ok: false, reason: `${headCheck.reason} — publish only runs from a fully-merged main.` };
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
  const lockfileCheck = checkLockfileVersions(deps.repoRoot, lockstep.version);
  if (!lockfileCheck.ok) return { ok: false, reason: lockfileCheck.message };
  const marketplaceRefCheck = checkMarketplaceRef(join(deps.repoRoot, MARKETPLACE_PATH), lockstep.version);
  if (!marketplaceRefCheck.ok) return { ok: false, reason: marketplaceRefCheck.message };
  const changelog = readFileSync(join(deps.repoRoot, "CHANGELOG.md"), "utf8");
  if (!changelogHasSection(changelog, lockstep.version)) {
    return { ok: false, reason: `CHANGELOG.md has no "## [${lockstep.version}]" section.` };
  }
  const tag = `v${lockstep.version}`;
  if (checkTagExists(deps, tag)) {
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
  {
    // Pre-releases must never become `latest` — that's the tag `npm install sapwood` (no
    // version) and `npx sapwood@latest` resolve, so a pre-release landing there would
    // silently become the default install for everyone. Runs after gh-release: the tag +
    // GitHub Release are the durable, always-true record of what was cut, so a step that
    // can still fail for reasons outside this script's control (an npm outage, a stale
    // local `npm login`) runs last, after everything durable already exists. If it does
    // fail, `publish` itself is NOT safely re-runnable — `checkPublishPreconditions`
    // refuses once the tag exists — see docs/dev-guide/10-releasing.md's Rollback section
    // for the manual one-line retry instead.
    name: "npm-publish",
    describe: (ctx) => `npm publish --workspace engine --tag ${npmDistTag(ctx)}`,
    run: (ctx, deps) => {
      deps.exec("npm", ["publish", "--workspace", "engine", "--tag", npmDistTag(ctx)]);
    },
  },
];

// npm's own dist-tag equivalent of gh-release's `--prerelease` flag: a plain release always
// publishes `latest`. A pre-release uses its own first identifier as the tag (`alpha`/`beta`/
// `rc`, matching the pre-1.0 ladder in docs/dev-guide/10-releasing.md) when that identifier is
// purely alphabetic, so distinct pre-release tracks (`0.3.0-beta.1` vs `0.3.0-rc.1`) install
// side by side under their own tags rather than colliding on a single hardcoded `alpha`. A
// non-alphabetic first identifier (`0.3.0-1`) has no name to reuse as a tag, so it falls back
// to the generic `next` — never `latest`, which is the one invariant that actually matters here.
export function npmDistTag(ctx: PublishContext): string {
  if (!ctx.prerelease) return "latest";
  const [firstIdentifier] = parseSemver(ctx.version).prerelease;
  return firstIdentifier !== undefined && /^[a-zA-Z]+$/.test(firstIdentifier) ? firstIdentifier.toLowerCase() : "next";
}

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

  const headCheck = checkHeadMatchesOriginMain(deps);
  if (!headCheck.ok) {
    return { code: 1, output: `release prepare: ${headCheck.reason} — prepare only runs from an up-to-date main.\n` };
  }

  const dirty = deps.exec("git", ["status", "--porcelain"]).trim();
  if (dirty !== "") return { code: 1, output: "release prepare: working tree is dirty — commit or stash first.\n" };

  const changelogPath = join(deps.repoRoot, "CHANGELOG.md");
  const changelog = readFileSync(changelogPath, "utf8");
  if (extractUnreleasedBody(changelog) === "") {
    return { code: 1, output: "release prepare: CHANGELOG.md's Unreleased section is empty — nothing to release.\n" };
  }

  const lockstep = checkManifestLockstep(MANIFEST_PATHS.map((p) => join(deps.repoRoot, p)));
  if (!lockstep.ok) return { code: 1, output: `release prepare: ${lockstep.message}\n` };
  if (lockstep.version !== "0.0.0" && compareSemver(version, lockstep.version) <= 0) {
    return { code: 1, output: `release prepare: ${version} is not greater than the current version ${lockstep.version}.\n` };
  }

  const branch = `release/v${version}`;
  const actions: string[] = [];

  deps.exec("git", ["checkout", "-b", branch]);
  actions.push(`created branch ${branch}`);

  for (const p of MANIFEST_PATHS) {
    writeManifestVersion(join(deps.repoRoot, p), version);
    actions.push(`bumped ${p} -> ${version}`);
  }

  const marketplaceRef = marketplaceRefFor(version);
  writeMarketplaceRef(join(deps.repoRoot, MARKETPLACE_PATH), marketplaceRef);
  actions.push(`set ${MARKETPLACE_PATH} plugins[0].source.ref -> ${marketplaceRef}`);

  // package-lock.json's root/engine/dashboard entries are DERIVED from the four manifests
  // just bumped above, never hand-set — `--package-lock-only` skips reinstalling
  // node_modules (this only needs to happen once, at publish time, not on every prepare) and
  // `--ignore-scripts` keeps a version bump from ever running arbitrary package lifecycle code.
  deps.exec("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
  actions.push("regenerated package-lock.json (npm install --package-lock-only --ignore-scripts)");
  const lockfileCheck = checkLockfileVersions(deps.repoRoot, version);
  if (!lockfileCheck.ok) {
    return { code: 1, output: `release prepare: ${lockfileCheck.message}\n` };
  }

  const date = formatChangelogDate(new Date());
  const updatedChangelog = moveUnreleasedToVersion(changelog, version, date);
  writeFileSync(changelogPath, updatedChangelog);
  actions.push(`moved CHANGELOG Unreleased -> [${version}] - ${date}`);

  deps.exec("git", ["add", ...MANIFEST_PATHS, MARKETPLACE_PATH, "package-lock.json", "CHANGELOG.md"]);
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
