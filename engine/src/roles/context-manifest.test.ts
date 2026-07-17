// context-manifest.test.ts (#236): assembleContextManifest is PURE (fixture env in, manifest
// out — no filesystem/subprocess) per the issue's verification plan; resolveWorktreeHead is the
// one fs-touching exception (pure git-plumbing reads, exercised against a real hand-built
// worktree directory structure below).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assembleContextManifest, type ContextManifestEnv, resolveWorktreeHead } from "./context-manifest.js";

const baseEnv = (over: Partial<ContextManifestEnv> = {}): ContextManifestEnv => ({
  sources: [],
  model: "sonnet",
  cliBin: "claude",
  mcpTools: [],
  worktree: { path: "/wt", head: null, headResolution: "unresolved", dirty: false, dirtyBasis: "structural-no-write-tools" },
  settingsJson: "{}",
  hookContent: null,
  recordedAt: "2026-07-17T00:00:00Z",
  ...over,
});

test("assembleContextManifest: a fixture env with two CLAUDE.md sources (one git-recoverable, one mutable) and a dirty worktree — all fields present, mutable source content-addressed as a snapshot", () => {
  const manifest = assembleContextManifest(
    baseEnv({
      sources: [
        { label: "repo CLAUDE.md", path: "/wt/CLAUDE.md", content: "# repo conventions", gitCommit: "a".repeat(40) },
        { label: "user-global CLAUDE.md", path: "/home/u/.claude/CLAUDE.md", content: "# user prefs" },
      ],
      worktree: { path: "/wt", head: "a".repeat(40), headResolution: "resolved", dirty: true, dirtyBasis: "measured" },
    }),
  );
  assert.equal(manifest.sources.length, 2);

  const repo = manifest.sources[0]!;
  assert.equal(repo.kind, "git");
  assert.equal(repo.label, "repo CLAUDE.md");
  assert.equal((repo as { commit: string }).commit, "a".repeat(40));
  assert.ok((repo as { hash: string }).hash.length === 64, "sha256 hex digest");
  assert.equal((repo as { content?: string }).content, undefined, "git-recoverable sources never duplicate content");

  const user = manifest.sources[1]!;
  assert.equal(user.kind, "snapshot");
  assert.equal(
    (user as { content: string }).content,
    "# user prefs",
    "mutable source content is CAPTURED, not just a hash of now-possibly-lost content",
  );
  assert.ok((user as { hash: string }).hash.length === 64);

  assert.deepEqual(manifest.worktree, {
    path: "/wt",
    head: "a".repeat(40),
    headResolution: "resolved",
    dirty: true,
    dirtyBasis: "measured",
  });
  assert.equal(manifest.recordedAt, "2026-07-17T00:00:00Z");
});

test("assembleContextManifest: an absent source (path effective but missing on disk) is recorded, not dropped", () => {
  const manifest = assembleContextManifest(
    baseEnv({ sources: [{ label: "auto-memory MEMORY.md", path: "/mem/MEMORY.md", content: null }] }),
  );
  assert.deepEqual(manifest.sources, [{ kind: "absent", label: "auto-memory MEMORY.md", path: "/mem/MEMORY.md" }]);
});

test("assembleContextManifest: toolSchemaVersion/promptTemplateVersion are content hashes — present when input is non-empty, null otherwise, order-independent for tools", () => {
  const withTools = assembleContextManifest(baseEnv({ toolSchemaTools: ["Read", "Write"], promptTemplateSource: "do the thing" }));
  assert.ok(withTools.toolSchemaVersion && withTools.toolSchemaVersion.length === 64);
  assert.ok(withTools.promptTemplateVersion && withTools.promptTemplateVersion.length === 64);

  const reordered = assembleContextManifest(baseEnv({ toolSchemaTools: ["Write", "Read"] }));
  assert.equal(reordered.toolSchemaVersion, withTools.toolSchemaVersion, "tool list hashing is order-independent");

  const noTools = assembleContextManifest(baseEnv());
  assert.equal(noTools.toolSchemaVersion, null);
  assert.equal(noTools.promptTemplateVersion, null);
});

test("assembleContextManifest: mcpTools are sorted for determinism; settingsHash/hookHash are content hashes, hookHash null when hookContent is null", () => {
  const manifest = assembleContextManifest(
    baseEnv({ mcpTools: ["zeta:pending", "alpha:disabled"], settingsJson: '{"a":1}', hookContent: "hook body" }),
  );
  assert.deepEqual(manifest.mcpTools, ["alpha:disabled", "zeta:pending"]);
  assert.ok(manifest.settingsHash.length === 64);
  assert.ok(manifest.hookHash && manifest.hookHash.length === 64);

  const noHook = assembleContextManifest(baseEnv({ hookContent: null }));
  assert.equal(noHook.hookHash, null);
});

test("assembleContextManifest: drift detection — identical env hashes identically; a single changed byte in a mutable source changes ITS hash but leaves every other field untouched", () => {
  const attempt1 = assembleContextManifest(
    baseEnv({ sources: [{ label: "user-global CLAUDE.md", path: "/home/u/.claude/CLAUDE.md", content: "v1" }] }),
  );
  const attempt2 = assembleContextManifest(
    baseEnv({ sources: [{ label: "user-global CLAUDE.md", path: "/home/u/.claude/CLAUDE.md", content: "v2" }] }),
  );
  const s1 = attempt1.sources[0] as { hash: string };
  const s2 = attempt2.sources[0] as { hash: string };
  assert.notEqual(s1.hash, s2.hash, "ambient drift between two attempts must be visible in the hash");
  assert.equal(attempt1.model, attempt2.model);
  assert.equal(attempt1.settingsHash, attempt2.settingsHash);
});

test("assembleContextManifest: never throws on a manifestly empty env", () => {
  assert.doesNotThrow(() => assembleContextManifest(baseEnv()));
});

// ── resolveWorktreeHead: pure filesystem git-plumbing reads (no subprocess) ─────────────────

test("resolveWorktreeHead: a linked worktree with a symbolic-ref HEAD resolves via the shared common dir's loose ref", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ctxmanifest-"));
  try {
    const mainGitDir = join(dir, "main", ".git");
    const worktreeDir = join(dir, "wt1");
    const wtGitDir = join(mainGitDir, "worktrees", "wt1");
    mkdirSync(join(mainGitDir, "refs", "heads"), { recursive: true });
    mkdirSync(wtGitDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    const sha = "b".repeat(40);
    writeFileSync(join(mainGitDir, "refs", "heads", "main"), `${sha}\n`);
    writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(wtGitDir, "commondir"), "../..\n"); // wt1's gitdir -> ../.. -> mainGitDir
    writeFileSync(join(worktreeDir, ".git"), `gitdir: ${wtGitDir}\n`);

    assert.equal(resolveWorktreeHead(worktreeDir), sha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorktreeHead: a detached HEAD (bare 40-hex sha) resolves directly, lowercased", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ctxmanifest-"));
  try {
    const worktreeDir = join(dir, "wt1");
    const wtGitDir = join(dir, "main", ".git", "worktrees", "wt1");
    mkdirSync(wtGitDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    const sha = "C".repeat(40); // uppercase input -> lowercase output
    writeFileSync(join(wtGitDir, "HEAD"), `${sha}\n`);
    writeFileSync(join(worktreeDir, ".git"), `gitdir: ${wtGitDir}\n`);

    assert.equal(resolveWorktreeHead(worktreeDir), sha.toLowerCase());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorktreeHead: falls back to packed-refs when no loose ref file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ctxmanifest-"));
  try {
    const mainGitDir = join(dir, "main", ".git");
    const worktreeDir = join(dir, "wt1");
    const wtGitDir = join(mainGitDir, "worktrees", "wt1");
    mkdirSync(mainGitDir, { recursive: true });
    mkdirSync(wtGitDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    const sha = "d".repeat(40);
    writeFileSync(join(mainGitDir, "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/heads/main\n`);
    writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(wtGitDir, "commondir"), "../..\n");
    writeFileSync(join(worktreeDir, ".git"), `gitdir: ${wtGitDir}\n`);

    assert.equal(resolveWorktreeHead(worktreeDir), sha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorktreeHead: honest null (never a guess, never a throw) for a non-worktree directory, a missing HEAD, and an unresolvable ref", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ctxmanifest-"));
  try {
    // Plain directory (not a linked-worktree `.git` FILE) — not the shape this function handles.
    const plainDir = join(dir, "plain");
    mkdirSync(join(plainDir, ".git"), { recursive: true });
    assert.equal(resolveWorktreeHead(plainDir), null);

    // No .git at all.
    const bareDir = join(dir, "bare");
    mkdirSync(bareDir, { recursive: true });
    assert.equal(resolveWorktreeHead(bareDir), null);

    // .git FILE present but gitdir target has no HEAD file.
    const noHeadDir = join(dir, "nohead");
    const noHeadGitDir = join(dir, "nohead-gitdir");
    mkdirSync(noHeadDir, { recursive: true });
    mkdirSync(noHeadGitDir, { recursive: true });
    writeFileSync(join(noHeadDir, ".git"), `gitdir: ${noHeadGitDir}\n`);
    assert.equal(resolveWorktreeHead(noHeadDir), null);

    // A ref that resolves nowhere (no loose file, no packed-refs entry).
    const unresolvableDir = join(dir, "unresolvable");
    const unresolvableGitDir = join(dir, "unresolvable-gitdir");
    mkdirSync(unresolvableDir, { recursive: true });
    mkdirSync(unresolvableGitDir, { recursive: true });
    writeFileSync(join(unresolvableGitDir, "HEAD"), "ref: refs/heads/ghost\n");
    writeFileSync(join(unresolvableDir, ".git"), `gitdir: ${unresolvableGitDir}\n`);
    assert.equal(resolveWorktreeHead(unresolvableDir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
