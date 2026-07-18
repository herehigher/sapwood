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
  probedPaths: [],
  knownUnprobed: "imports, ancestor dirs, managed policy",
  capturedPreSpawn: "2026-07-17T00:00:00Z",
  capturedPostExit: "2026-07-17T00:00:01Z",
  captureBasis: "init-observed",
  model: "sonnet",
  modelSource: "requested-fallback",
  cliBin: "claude",
  mcpTools: [],
  worktree: { path: "/wt", head: null, headResolution: "unresolved", dirty: false, dirtyBasis: "structural-no-write-tools" },
  settingsJson: "{}",
  hookContent: null,
  recordedAt: "2026-07-17T00:00:01Z",
  ...over,
});

test("assembleContextManifest (Codex F1, R1): captureBasis passes through verbatim — never silently assumed reliable", () => {
  const observed = assembleContextManifest(baseEnv({ captureBasis: "init-observed" }));
  assert.equal(observed.captureBasis, "init-observed");
  const fallback = assembleContextManifest(baseEnv({ captureBasis: "timeout-fallback" }));
  assert.equal(fallback.captureBasis, "timeout-fallback");
});

test("assembleContextManifest: a fixture env with two CLAUDE.md sources (one worktree-rooted with an advisory gitCommit, one mutable) and a dirty worktree — all fields present, EVERY present source content-addressed inline (Codex F3)", () => {
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
  assert.equal(repo.kind, "snapshot", "Codex F3: even a worktree-rooted, git-pinned source is captured inline, never hash-only");
  assert.equal(repo.label, "repo CLAUDE.md");
  assert.equal((repo as { content: string }).content, "# repo conventions");
  assert.ok((repo as { hash: string }).hash.length === 64, "sha256 hex digest");
  assert.equal((repo as { gitCommit?: string }).gitCommit, "a".repeat(40), "gitCommit survives as ADVISORY metadata only");

  const user = manifest.sources[1]!;
  assert.equal(user.kind, "snapshot");
  assert.equal(
    (user as { content: string }).content,
    "# user prefs",
    "mutable source content is CAPTURED, not just a hash of now-possibly-lost content",
  );
  assert.equal((user as { gitCommit?: string }).gitCommit, undefined, "no gitCommit was supplied for this source");
  assert.ok((user as { hash: string }).hash.length === 64);

  assert.deepEqual(manifest.worktree, {
    path: "/wt",
    head: "a".repeat(40),
    headResolution: "resolved",
    dirty: true,
    dirtyBasis: "measured",
  });
  assert.equal(manifest.recordedAt, "2026-07-17T00:00:01Z");
});

test("assembleContextManifest: an absent source (path effective but missing on disk) is recorded, not dropped — reason defaults to 'absent' when the caller omits it", () => {
  const manifest = assembleContextManifest(
    baseEnv({ sources: [{ label: "auto-memory MEMORY.md", path: "/mem/MEMORY.md", content: null }] }),
  );
  assert.deepEqual(manifest.sources, [{ kind: "absent", label: "auto-memory MEMORY.md", path: "/mem/MEMORY.md", reason: "absent" }]);
});

test("assembleContextManifest (Codex F5b): 'unreadable' is preserved distinctly from 'absent' — a permissions/read failure must never masquerade as 'this layer legitimately doesn't exist'", () => {
  const manifest = assembleContextManifest(
    baseEnv({ sources: [{ label: "repo CLAUDE.md", path: "/wt/CLAUDE.md", content: null, reason: "unreadable" }] }),
  );
  assert.deepEqual(manifest.sources, [{ kind: "absent", label: "repo CLAUDE.md", path: "/wt/CLAUDE.md", reason: "unreadable" }]);
});

test("assembleContextManifest (Codex F2b): probedPaths/knownUnprobed pass through verbatim, defensively copied", () => {
  const paths = ["/wt/CLAUDE.md", "/wt/CLAUDE.local.md"];
  const manifest = assembleContextManifest(baseEnv({ probedPaths: paths, knownUnprobed: "imports, ancestor dirs, managed policy" }));
  assert.deepEqual(manifest.probedPaths, paths);
  assert.notEqual(manifest.probedPaths, paths, "defensive copy, not the same array reference");
  assert.equal(manifest.knownUnprobed, "imports, ancestor dirs, managed policy");
});

test("assembleContextManifest (Codex F1): capturedPreSpawn/capturedPostExit pass through independently — the manifest states its own two-phase timing", () => {
  const manifest = assembleContextManifest(baseEnv({ capturedPreSpawn: "2026-07-17T00:00:00Z", capturedPostExit: "2026-07-17T00:05:00Z" }));
  assert.equal(manifest.capturedPreSpawn, "2026-07-17T00:00:00Z");
  assert.equal(manifest.capturedPostExit, "2026-07-17T00:05:00Z");
});

test("assembleContextManifest (Codex F5a): modelSource is never silently inferred — passes through exactly what the caller supplied", () => {
  const fromInit = assembleContextManifest(baseEnv({ model: "claude-haiku", modelSource: "session-init" }));
  assert.equal(fromInit.modelSource, "session-init");
  const fromFallback = assembleContextManifest(baseEnv({ model: "sonnet", modelSource: "requested-fallback" }));
  assert.equal(fromFallback.modelSource, "requested-fallback");
});

test("assembleContextManifest (Codex F5c): toolInventoryHash/promptTemplateVersion are content hashes — present when input is non-empty, null otherwise, order-independent for tools", () => {
  const withTools = assembleContextManifest(baseEnv({ toolInventoryTools: ["Read", "Write"], promptTemplateSource: "do the thing" }));
  assert.ok(withTools.toolInventoryHash && withTools.toolInventoryHash.length === 64);
  assert.ok(withTools.promptTemplateVersion && withTools.promptTemplateVersion.length === 64);

  const reordered = assembleContextManifest(baseEnv({ toolInventoryTools: ["Write", "Read"] }));
  assert.equal(reordered.toolInventoryHash, withTools.toolInventoryHash, "tool list hashing is order-independent");

  const noTools = assembleContextManifest(baseEnv());
  assert.equal(noTools.toolInventoryHash, null);
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

// ── #235 PR-B: toolUsage/readPaths — the "what did this session actually use" half ──────────

test("assembleContextManifest (#235 PR-B): toolUsage/readPaths pass through verbatim when supplied", () => {
  const manifest = assembleContextManifest(
    baseEnv({
      toolUsage: [
        { tool: "Read", count: 3 },
        { tool: "Grep", count: 1 },
      ],
      readPaths: ["src/foo.ts", "src/bar.ts"],
    }),
  );
  assert.deepEqual(manifest.toolUsage, [
    { tool: "Read", count: 3 },
    { tool: "Grep", count: 1 },
  ]);
  assert.deepEqual(manifest.readPaths, ["src/foo.ts", "src/bar.ts"]);
});

test("assembleContextManifest (#235 PR-B): toolUsage/readPaths default to [] when omitted — existing fixtures/tests that predate this field keep compiling with an honest empty result, never undefined", () => {
  const manifest = assembleContextManifest(baseEnv());
  assert.deepEqual(manifest.toolUsage, []);
  assert.deepEqual(manifest.readPaths, []);
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

test("resolveWorktreeHead (Codex F4 regression — empirically proven wrong before this fix): a STALE worktree-local refs/heads file must NOT shadow the real ref in the shared common store", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ctxmanifest-"));
  try {
    const mainGitDir = join(dir, "main", ".git");
    const worktreeDir = join(dir, "wt1");
    const wtGitDir = join(mainGitDir, "worktrees", "wt1");
    mkdirSync(join(mainGitDir, "refs", "heads"), { recursive: true });
    // A stale/shadowing per-worktree copy of the SAME ref path — this is the exact shape the
    // pre-fix implementation's "worktree-local first" lookup order got wrong: `refs/heads/*` is
    // a SHARED namespace, so this file must never even be consulted, let alone win.
    mkdirSync(join(wtGitDir, "refs", "heads"), { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    const realSha = "e".repeat(40);
    const staleSha = "f".repeat(40);
    writeFileSync(join(mainGitDir, "refs", "heads", "main"), `${realSha}\n`);
    writeFileSync(join(wtGitDir, "refs", "heads", "main"), `${staleSha}\n`); // the shadow
    writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(wtGitDir, "commondir"), "../..\n");
    writeFileSync(join(worktreeDir, ".git"), `gitdir: ${wtGitDir}\n`);

    const resolved = resolveWorktreeHead(worktreeDir);
    assert.equal(resolved, realSha, "the shared common store's ref wins — the worktree-local shadow is never consulted");
    assert.notEqual(resolved, staleSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorktreeHead (Codex F4 residual, R3 — direction was inverted): a shared namespace OTHER than heads/tags/remotes (refs/notes/*) resolves from the common store too, ignoring a worktree-local shadow", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ctxmanifest-"));
  try {
    const mainGitDir = join(dir, "main", ".git");
    const worktreeDir = join(dir, "wt1");
    const wtGitDir = join(mainGitDir, "worktrees", "wt1");
    mkdirSync(join(mainGitDir, "refs", "notes"), { recursive: true });
    // The ORIGINAL (wrong-direction) fix treated `refs/notes/*` as worktree-local by default
    // (only heads/tags/remotes were shared) — so this worktree-local shadow would have won.
    // Under the corrected model, `refs/notes/*` is shared (not in the small local set), so this
    // file must never even be consulted.
    mkdirSync(join(wtGitDir, "refs", "notes"), { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    const realSha = "a".repeat(40);
    const staleSha = "b".repeat(40);
    writeFileSync(join(mainGitDir, "refs", "notes", "x"), `${realSha}\n`);
    writeFileSync(join(wtGitDir, "refs", "notes", "x"), `${staleSha}\n`); // the shadow
    writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/notes/x\n");
    writeFileSync(join(wtGitDir, "commondir"), "../..\n");
    writeFileSync(join(worktreeDir, ".git"), `gitdir: ${wtGitDir}\n`);

    const resolved = resolveWorktreeHead(worktreeDir);
    assert.equal(resolved, realSha, "the shared common store's ref wins for a non-heads/tags/remotes namespace too");
    assert.notEqual(resolved, staleSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorktreeHead (Codex F4): a per-worktree ref namespace (refs/bisect/*) resolves worktree-local, never from the common dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ctxmanifest-"));
  try {
    const mainGitDir = join(dir, "main", ".git");
    const worktreeDir = join(dir, "wt1");
    const wtGitDir = join(mainGitDir, "worktrees", "wt1");
    mkdirSync(join(wtGitDir, "refs", "bisect"), { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    const sha = "1".repeat(40);
    writeFileSync(join(wtGitDir, "refs", "bisect", "bad"), `${sha}\n`);
    writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/bisect/bad\n");
    writeFileSync(join(wtGitDir, "commondir"), "../..\n");
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
