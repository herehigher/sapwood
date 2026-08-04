// skills-plugin.test.ts — #639: the renderer's own determinism/atomic-publish/fail-closed/
// content-fidelity contract. Injection-policy-table and claudeArgs wiring are covered by
// worker.test.ts/peripheral.test.ts (the call sites this module's output feeds).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildSkillsPluginFiles,
  extractMarkedSection,
  hashPluginFiles,
  publishPluginAtomic,
  renderSkillsPlugin,
  resolveSkillsPluginDir,
  SKILLS_PLUGIN_SPECS,
  shouldInjectSkillsPlugin,
  writePluginFiles,
} from "./skills-plugin.js";

const FIXTURE_SECURITY_MD = `# Security & trust model

## Human-merge-only paths

<!-- sapwood:skill:human-merge-only-paths:start -->
Some files are structurally off-limits to an autonomous worker.

- \`guard.ts\`
- \`sapwood.config.yaml\`
<!-- sapwood:skill:human-merge-only-paths:end -->

### a subsection that must not be pulled in

not part of the skill.

## AC evidence

### Doctrine lines

<!-- sapwood:skill:ac-evidence-tiers:start -->
- **AC evidence is tiered by trust origin.**
  - A — engine-verified.
  - B — CI-executed.
<!-- sapwood:skill:ac-evidence-tiers:end -->
- a sibling doctrine bullet that must not be pulled in.
`;

function mkTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "sapwood-skills-plugin-"));
}

// ── extractMarkedSection ─────────────────────────────────────────────────────────────────────

test("extractMarkedSection: happy path trims to exactly the marker-delimited body", () => {
  const body = extractMarkedSection(FIXTURE_SECURITY_MD, "human-merge-only-paths");
  assert.equal(body, "Some files are structurally off-limits to an autonomous worker.\n\n- `guard.ts`\n- `sapwood.config.yaml`");
  assert.ok(!body.includes("subsection that must not be pulled in"));
});

test("extractMarkedSection: a second skill's markers are independent of the first", () => {
  const body = extractMarkedSection(FIXTURE_SECURITY_MD, "ac-evidence-tiers");
  assert.ok(body.includes("A — engine-verified"));
  assert.ok(!body.includes("sibling doctrine bullet"));
});

test("extractMarkedSection: missing start marker throws, naming the id", () => {
  assert.throws(() => extractMarkedSection("no markers here", "human-merge-only-paths"), /missing start marker.*human-merge-only-paths/);
});

test("extractMarkedSection: missing end marker throws, naming the id", () => {
  const src = "<!-- sapwood:skill:x:start -->\nbody";
  assert.throws(() => extractMarkedSection(src, "x"), /missing end marker.*"x"/);
});

test("extractMarkedSection: duplicated start marker throws", () => {
  const src = "<!-- sapwood:skill:x:start -->a<!-- sapwood:skill:x:start -->b<!-- sapwood:skill:x:end -->";
  assert.throws(() => extractMarkedSection(src, "x"), /duplicated start marker.*"x"/);
});

test("extractMarkedSection: duplicated end marker throws", () => {
  const src = "<!-- sapwood:skill:x:start -->a<!-- sapwood:skill:x:end -->b<!-- sapwood:skill:x:end -->";
  assert.throws(() => extractMarkedSection(src, "x"), /duplicated end marker.*"x"/);
});

test("extractMarkedSection: end marker before start marker throws", () => {
  const src = "<!-- sapwood:skill:x:end --> ... <!-- sapwood:skill:x:start -->";
  assert.throws(() => extractMarkedSection(src, "x"), /end marker precedes start marker/);
});

// ── buildSkillsPluginFiles (pure) ────────────────────────────────────────────────────────────

test("buildSkillsPluginFiles: produces the plugin manifest + one SKILL.md per spec, sorted by path", () => {
  const files = buildSkillsPluginFiles(FIXTURE_SECURITY_MD);
  const paths = files.map((f) => f.relPath);
  assert.deepEqual(
    paths,
    [".claude-plugin/plugin.json", ...SKILLS_PLUGIN_SPECS.map((s) => `skills/${s.id}/SKILL.md`)].sort((a, b) => a.localeCompare(b)),
  );
});

test("buildSkillsPluginFiles: plugin.json is valid JSON naming the plugin", () => {
  const manifest = buildSkillsPluginFiles(FIXTURE_SECURITY_MD).find((f) => f.relPath === ".claude-plugin/plugin.json")!;
  const parsed = JSON.parse(manifest.content);
  assert.equal(parsed.name, "sapwood-role-skills");
});

test("buildSkillsPluginFiles: each SKILL.md body byte-matches the corresponding marker-delimited security.md section", () => {
  const files = buildSkillsPluginFiles(FIXTURE_SECURITY_MD);
  for (const spec of SKILLS_PLUGIN_SPECS) {
    const skillMd = files.find((f) => f.relPath === `skills/${spec.id}/SKILL.md`)!.content;
    const frontmatterEnd = skillMd.indexOf("---\n\n");
    const body = skillMd.slice(frontmatterEnd + "---\n\n".length);
    const expected = `${extractMarkedSection(FIXTURE_SECURITY_MD, spec.id)}\n`;
    assert.equal(body, expected, `skill "${spec.id}" body must byte-match its security.md section`);
  }
});

test("buildSkillsPluginFiles: SKILL.md frontmatter carries name + non-empty description", () => {
  const files = buildSkillsPluginFiles(FIXTURE_SECURITY_MD);
  for (const spec of SKILLS_PLUGIN_SPECS) {
    const skillMd = files.find((f) => f.relPath === `skills/${spec.id}/SKILL.md`)!.content;
    assert.match(skillMd, new RegExp(`^---\\nname: ${spec.id}\\ndescription: .+\\n---\\n\\n`));
  }
});

// ── hashPluginFiles ──────────────────────────────────────────────────────────────────────────

test("hashPluginFiles: identical file sets hash identically", () => {
  const a = buildSkillsPluginFiles(FIXTURE_SECURITY_MD);
  const b = buildSkillsPluginFiles(FIXTURE_SECURITY_MD);
  assert.equal(hashPluginFiles(a), hashPluginFiles(b));
});

test("hashPluginFiles: a changed source section changes the hash", () => {
  const before = hashPluginFiles(buildSkillsPluginFiles(FIXTURE_SECURITY_MD));
  const changed = FIXTURE_SECURITY_MD.replace("B — CI-executed.", "B — CI-executed (edited).");
  const after = hashPluginFiles(buildSkillsPluginFiles(changed));
  assert.notEqual(before, after);
});

// ── renderSkillsPlugin: determinism + atomic publish ────────────────────────────────────────

test("renderSkillsPlugin: same source -> same hash, second call creates no new directory and leaves files untouched", () => {
  const root = mkTmpDir();
  try {
    const securityMdPath = join(root, "security.md");
    writeFileSync(securityMdPath, FIXTURE_SECURITY_MD, "utf8");
    const outRoot = join(root, "out");

    const first = renderSkillsPlugin({ securityMdPath, outRoot });
    const manifestPath = join(first.dir, ".claude-plugin", "plugin.json");
    const mtimeBefore = statSync(manifestPath).mtimeMs;
    const dirsBefore = readdirSync(outRoot);

    const second = renderSkillsPlugin({ securityMdPath, outRoot });

    assert.equal(second.hash, first.hash);
    assert.equal(second.dir, first.dir);
    assert.equal(statSync(manifestPath).mtimeMs, mtimeBefore, "a no-op re-render must not rewrite the published file");
    assert.deepEqual(readdirSync(outRoot), dirsBefore, "a no-op re-render must not create a new directory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderSkillsPlugin: a changed source produces a new directory and leaves the previously-published one byte-untouched", () => {
  const root = mkTmpDir();
  try {
    const securityMdPath = join(root, "security.md");
    writeFileSync(securityMdPath, FIXTURE_SECURITY_MD, "utf8");
    const outRoot = join(root, "out");

    const first = renderSkillsPlugin({ securityMdPath, outRoot });
    const firstManifestBefore = readFileSync(join(first.dir, ".claude-plugin", "plugin.json"), "utf8");

    writeFileSync(securityMdPath, FIXTURE_SECURITY_MD.replace("B — CI-executed.", "B — CI-executed (edited)."), "utf8");
    const second = renderSkillsPlugin({ securityMdPath, outRoot });

    assert.notEqual(second.hash, first.hash);
    assert.notEqual(second.dir, first.dir);
    assert.ok(existsSync(first.dir), "the prior hash directory must still exist");
    assert.equal(
      readFileSync(join(first.dir, ".claude-plugin", "plugin.json"), "utf8"),
      firstManifestBefore,
      "the prior hash directory's own files must be byte-unchanged",
    );
    const secondSkillMd = readFileSync(join(second.dir, "skills", "ac-evidence-tiers", "SKILL.md"), "utf8");
    assert.ok(secondSkillMd.includes("edited"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderSkillsPlugin: crash-consistency — a staged-but-never-renamed directory from an interrupted prior run does not block a clean re-render", () => {
  const root = mkTmpDir();
  try {
    const securityMdPath = join(root, "security.md");
    writeFileSync(securityMdPath, FIXTURE_SECURITY_MD, "utf8");
    const outRoot = join(root, "out");
    mkdirSync(outRoot, { recursive: true });

    // Reproduce exactly what a process killed between "stage" and "rename" leaves behind: a
    // fully-written directory that is NOT the published hash path and that renderSkillsPlugin
    // itself never created a reference to.
    const orphanStageDir = join(outRoot, ".stage-orphan-from-a-crash");
    const files = buildSkillsPluginFiles(FIXTURE_SECURITY_MD);
    writePluginFiles(orphanStageDir, files);
    assert.ok(existsSync(orphanStageDir));

    const result = renderSkillsPlugin({ securityMdPath, outRoot });

    assert.notEqual(result.dir, orphanStageDir, "argv must never be handed the orphaned stage directory");
    assert.equal(hashPluginFiles(files), result.hash);
    assert.ok(existsSync(join(result.dir, ".claude-plugin", "plugin.json")), "the real render must complete cleanly and fully");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishPluginAtomic: publishing the same hash twice directly is a no-op on the second call", () => {
  const root = mkTmpDir();
  try {
    const files = buildSkillsPluginFiles(FIXTURE_SECURITY_MD);
    const hash = hashPluginFiles(files);
    const first = publishPluginAtomic(root, hash, files);
    const before = statSync(join(first, ".claude-plugin", "plugin.json")).mtimeMs;
    const second = publishPluginAtomic(root, hash, files);
    assert.equal(second, first);
    assert.equal(statSync(join(first, ".claude-plugin", "plugin.json")).mtimeMs, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── fail-closed ──────────────────────────────────────────────────────────────────────────────

test("renderSkillsPlugin: a missing security.md file aborts with a naming error", () => {
  const root = mkTmpDir();
  try {
    assert.throws(
      () => renderSkillsPlugin({ securityMdPath: join(root, "nope.md"), outRoot: join(root, "out") }),
      /nope\.md.*refusing to start/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderSkillsPlugin: a security.md missing a required marker aborts startup, naming the marker", () => {
  const root = mkTmpDir();
  try {
    const securityMdPath = join(root, "security.md");
    writeFileSync(securityMdPath, "# no markers at all", "utf8");
    assert.throws(() => renderSkillsPlugin({ securityMdPath, outRoot: join(root, "out") }), /missing start marker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderSkillsPlugin: a security.md with a duplicated marker aborts startup, naming the marker", () => {
  const root = mkTmpDir();
  try {
    const securityMdPath = join(root, "security.md");
    writeFileSync(
      securityMdPath,
      FIXTURE_SECURITY_MD.replace("### a subsection", "<!-- sapwood:skill:human-merge-only-paths:start -->\n### a subsection"),
      "utf8",
    );
    assert.throws(() => renderSkillsPlugin({ securityMdPath, outRoot: join(root, "out") }), /duplicated start marker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── extracted-content fidelity against the REAL docs/security.md ───────────────────────────

test("renderSkillsPlugin: against this repo's real docs/security.md, every skill renders and byte-matches the live marker sections", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const realSecurityMdPath = join(here, "..", "..", "..", "docs", "security.md");
  const root = mkTmpDir();
  try {
    const result = renderSkillsPlugin({ securityMdPath: realSecurityMdPath, outRoot: join(root, "out") });
    const securityMd = readFileSync(realSecurityMdPath, "utf8");
    for (const spec of SKILLS_PLUGIN_SPECS) {
      const skillMd = readFileSync(join(result.dir, "skills", spec.id, "SKILL.md"), "utf8");
      const frontmatterEnd = skillMd.indexOf("---\n\n");
      const body = skillMd.slice(frontmatterEnd + "---\n\n".length);
      assert.equal(body, `${extractMarkedSection(securityMd, spec.id)}\n`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── resolveSkillsPluginDir (config wiring) ──────────────────────────────────────────────────

test("resolveSkillsPluginDir: roles.skills.enabled false -> undefined, no render attempted", () => {
  const root = mkTmpDir();
  try {
    // No docs/security.md under `root` at all — if this rendered anyway it would throw.
    const dir = resolveSkillsPluginDir({ roles: { skills: { enabled: false } } }, root);
    assert.equal(dir, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSkillsPluginDir: roles.skills.enabled true -> renders under <cwd>/data/generated/role-skills", () => {
  const root = mkTmpDir();
  try {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "security.md"), FIXTURE_SECURITY_MD, "utf8");
    const dir = resolveSkillsPluginDir({ roles: { skills: { enabled: true } } }, root);
    assert.ok(dir?.startsWith(join(root, "data", "generated", "role-skills")));
    assert.ok(existsSync(join(dir!, ".claude-plugin", "plugin.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── injection policy table ──────────────────────────────────────────────────────────────────

test("shouldInjectSkillsPlugin: every session kind except review is injected", () => {
  assert.equal(shouldInjectSkillsPlugin("worker-dispatch"), true);
  assert.equal(shouldInjectSkillsPlugin("worker-resume"), true);
  assert.equal(shouldInjectSkillsPlugin("worker-fix-entry"), true);
  assert.equal(shouldInjectSkillsPlugin("peripheral-role"), true);
  assert.equal(shouldInjectSkillsPlugin("review"), false);
});
