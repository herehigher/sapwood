// materializer.test.ts (#284) — covers every acceptance criterion in the issue against REAL git
// fixture repos, not mocks: bare-clone-outside-worktree-mounts + local-config-emptiness, the
// exact pinned invocation (args + env), a hooks/filter/replace-ref-laden fixture proving the
// PRIVATE clone materialization path is unaffected, a symlink fixture, `.git`-absence + OID
// verification, and instruction-file inclusion + manifest recording. `execFileSync` here is
// TEST-ONLY fixture plumbing (this file is excluded from the engine-wide child_process
// grep-invariant in worker.test.ts, which only scans non-`.test.ts` files).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertLocalConfigClean,
  assertOutsideWorktreeMounts,
  buildCheckoutInvocation,
  buildCloneInvocation,
  buildFetchInvocation,
  createPrivateClone,
  defaultPrivateCloneDir,
  defaultWorktreeRoot,
  MaterializerError,
  materialize,
} from "./materializer.js";

// ── fixture plumbing ────────────────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A real, non-bare git repo with gpg signing off (this sandbox has no signing key) and a
 *  deterministic identity, ready for fixture commits. */
function initSharedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-materializer-shared-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "user.email", "fixture@example.com"]);
  git(dir, ["config", "user.name", "fixture"]);
  return dir;
}

/** Bounds `promise` so a HANG surfaces as a clearly-labeled, named rejection instead of wedging
 *  the test runner until the job's own outer ceiling kills it. `ms` is generous — several
 *  seconds, comfortably above any real execution this suite ever does — so it only ever fires
 *  when the call under test is genuinely wedged (the exact regression class #406 blocked: a
 *  guarded assertion whose own failure mode, when the logic it guards regresses, is "hangs
 *  forever" rather than "fails with a message pointing at the cause"). Cleans up its own timer on
 *  either branch so a normal passing run never leaves a stray handle behind. Does not change what
 *  a NORMAL (non-hanging) rejection/resolution looks like -- it only adds a second, much slower,
 *  race partner. */
function withHangGuard<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Resolves the REAL system `git` binary's absolute path via the shell builtin `command -v`,
 *  invoked through `/bin/sh -c` (a real, standalone binary execFileSync can spawn directly --
 *  `command` itself is a shell builtin, not a standalone executable). Must be called BEFORE any
 *  test swaps `process.env.PATH` to point at a fake `git` -- baking the resolved ABSOLUTE path
 *  into the fake `git` script (below) means the fake script's own passthrough `exec` never has to
 *  consult `PATH` at all, so it always reaches the real binary regardless of what the swapped
 *  `PATH` says. */
function resolveRealGit(): string {
  return execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
}

/** #416 round-2 (Codex sol high): writes a SELECTIVE, SELF-TERMINATING fake `git` into `binDir`,
 *  replacing the blanket "hang on literally every invocation" shim the round-1 fix used. Round 1
 *  had two problems this fixes:
 *
 *  1. (P2) Hanging on the FIRST git call a test makes meant later calls in the same chain (e.g.
 *     the post-checkout `rev-parse --verify` in `materialize`, or the reuse fetch in
 *     `createPrivateClone`'s reuse path) were never actually reached -- a regression that dropped
 *     the `timeout` option from one of THOSE calls specifically would have left the test green.
 *     Fixed here by only faking the SPECIFIC operation(s) named in `targetWords`: any invocation
 *     whose argv contains one of those words as an EXACT positional argument -- never a substring
 *     match, since this suite's own clone/tree tmpdir paths routinely contain "clone" as a
 *     substring (`sapwood-materializer-clone-XXXX/clone.git`), which would false-positive a naive
 *     `includes()` check -- gets replaced with `exec sleep 20`; every other invocation `exec`s the
 *     REAL git at `realGitPath`. Earlier, cheap probes in the same call chain (config read,
 *     rev-parse --is-bare-repository, remote get-url) therefore complete for real, so the test
 *     genuinely walks the chain up to the specific call `targetWords` names before that call is
 *     the one that hangs.
 *  2. (P3) Both branches use `exec`, not a plain invocation -- this replaces the `sh` process
 *     image entirely rather than forking a child under it, so there is never an orphaned `sleep`
 *     grandchild left behind when execFile's `timeout` SIGTERMs the fake `git` (round 1's shim was
 *     `sh -c 'while true; do sleep 3600; done'`, where killing `sh` orphaned the `sleep 3600` for
 *     up to an hour). The kill signal now lands directly on the process actually doing the (fake)
 *     work.
 *
 *  Margin ordering (why none of this is a race between real work and a timer): the assertion path
 *  in every fixed test depends on EXACTLY ONE thing -- execFile's own `timeout` option (1ms in
 *  every one of these tests) killing a `sleep 20` child that does zero real work, a 4-order-of-
 *  magnitude gap (1ms vs 20,000ms) that is never close. The file's `withHangGuard` (5000ms) and
 *  this script's own self-exit (20s) only matter on the REGRESSION path -- if a future change
 *  drops the `timeout` option, `withHangGuard` still delivers a fast, named failure at 5s (another
 *  4-order-of-magnitude gap below the 20s self-exit), and the self-exit is pure defense in depth
 *  so the test FILE process still terminates on its own even if `withHangGuard` somehow didn't
 *  fire either -- never a multi-hour zombie the way an un-self-terminating hang would be. */
function writeSelectiveFakeGit(binDir: string, targetWords: readonly string[], realGitPath: string): void {
  const targets = targetWords.map((w) => `"${w}"`).join(" ");
  const script = `#!/bin/sh
for arg in "$@"; do
  for target in ${targets}; do
    if [ "$arg" = "$target" ]; then
      exec sleep 20
    fi
  done
done
exec "${realGitPath}" "$@"
`;
  writeFileSync(join(binDir, "git"), script);
  chmodSync(join(binDir, "git"), 0o755);
}

/** `timeoutMs` used by the "#395 P2" tests below THAT ROUTE ONE OR MORE REAL GIT CALLS through
 *  `writeSelectiveFakeGit`'s passthrough branch. Deliberately NOT `1` (unlike the plain
 *  fresh-clone test, which never runs a real git call at all): measured locally, a real local
 *  `git` subprocess invocation against these tiny fixture repos (`checkout`, `config --list`,
 *  `rev-parse --is-bare-repository`, `remote get-url`) consistently takes 15-30ms -- comfortably
 *  under 500ms, but routinely OVER 1ms. Racing those real passthrough calls against `1` would
 *  reintroduce the exact real-subprocess-vs-real-timer nondeterminism this whole fix removes (this
 *  was caught empirically: an earlier draft of this fix used `timeoutMs: 1` here and the real
 *  passthrough `checkout` itself got killed before completing, contradicting the very
 *  "checkout genuinely happened" assertion the test makes).
 *
 *  Margin ordering (why this is still not a race): the TARGET operation named in each test is
 *  faked to `exec sleep 20` regardless of `timeoutMs` -- the fake never does real work, so its
 *  20,000ms is not competing with anything, it just has to comfortably clear whatever `timeoutMs`
 *  is. `REAL_OP_TIMEOUT_MS` (500ms) sits ~20-30x above the real ops' measured 15-30ms (generous
 *  headroom for a loaded machine) and ~40x below the fake's 20,000ms sleep (so the `timeout`
 *  option always kills the fake, never lets it complete) -- two non-adjacent orders of magnitude
 *  on either side, not a close call in either direction. `withHangGuard`'s 5000ms (10x above this)
 *  and the fake's own 20s self-exit only matter on the REGRESSION path (the `timeout` option
 *  dropped from production code), never on the normal assertion path. */
const REAL_OP_TIMEOUT_MS = 500;

function headOid(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

// ── pure builders: pinned invocation contract ──────────────────────────────────────────────

test("buildCloneInvocation: pinned argv (--bare --no-hardlinks) and env forces GIT_CONFIG_GLOBAL/SYSTEM=/dev/null over any inherited value", () => {
  const { args, env } = buildCloneInvocation("/src/repo", "/priv/clone.git", {
    PATH: "/usr/bin",
    GIT_CONFIG_GLOBAL: "/tmp/attacker-global",
    GIT_CONFIG_SYSTEM: "/tmp/attacker-system",
  });
  assert.deepEqual(args, ["clone", "--bare", "--no-hardlinks", "/src/repo", "/priv/clone.git"]);
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null", "an ambient GIT_CONFIG_GLOBAL must never survive");
  assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null", "an ambient GIT_CONFIG_SYSTEM must never survive");
  assert.equal(env.PATH, "/usr/bin", "unrelated env is passed through");
});

test("buildCheckoutInvocation: pinned argv (-C, --work-tree, --no-replace-objects, hooks disabled, core.symlinks=false, -- .) and isolated env", () => {
  const { args, env } = buildCheckoutInvocation("/priv/clone.git", "/tmp/tree", "a".repeat(40), { PATH: "/usr/bin" });
  assert.deepEqual(args, [
    "-C",
    "/priv/clone.git",
    "--work-tree",
    "/tmp/tree",
    "--no-replace-objects",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.symlinks=false",
    "checkout",
    "a".repeat(40),
    "--",
    ".",
  ]);
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
});

test("buildCheckoutInvocation env isolation wins even when the CALLER's own env already sets GIT_CONFIG_GLOBAL/SYSTEM to something else", () => {
  const { env } = buildCheckoutInvocation("/c", "/t", "a".repeat(40), {
    GIT_CONFIG_GLOBAL: "/tmp/hostile-global.gitconfig",
    GIT_CONFIG_SYSTEM: "/tmp/hostile-system.gitconfig",
  });
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
});

test("buildFetchInvocation: pinned hooks-disabled mirror refspec and isolated env", () => {
  const { args, env } = buildFetchInvocation("/priv/clone.git", { PATH: "/usr/bin", GIT_CONFIG_GLOBAL: "/tmp/hostile" });
  assert.deepEqual(args, ["-C", "/priv/clone.git", "-c", "core.hooksPath=/dev/null", "fetch", "--prune", "origin", "+refs/*:refs/*"]);
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
  assert.equal(env.PATH, "/usr/bin");
});

// ── structural disjointness: bare clone provably outside worker worktree mounts ────────────

test("assertOutsideWorktreeMounts: rejects equal paths, clone nested inside worktreeRoot, and worktreeRoot nested inside clone", () => {
  assert.throws(() => assertOutsideWorktreeMounts("/x/worktrees", "/x/worktrees"), MaterializerError);
  assert.throws(() => assertOutsideWorktreeMounts("/x/worktrees/lane-1", "/x/worktrees"), MaterializerError);
  assert.throws(() => assertOutsideWorktreeMounts("/x", "/x/worktrees"), MaterializerError);
});

test("assertOutsideWorktreeMounts: accepts a structurally disjoint sibling directory", () => {
  assert.doesNotThrow(() => assertOutsideWorktreeMounts("/x/data/review/clone.git", "/x/.claude/worktrees"));
});

test("defaultPrivateCloneDir/defaultWorktreeRoot: shipped defaults are themselves structurally disjoint", () => {
  const cwd = "/repo";
  assert.doesNotThrow(() => assertOutsideWorktreeMounts(defaultPrivateCloneDir(cwd), defaultWorktreeRoot(cwd)));
  assert.equal(defaultPrivateCloneDir(cwd), join(cwd, "data", "review", "clone.git"));
  assert.equal(defaultWorktreeRoot(cwd), join(cwd, ".claude", "worktrees"));
});

test("assertOutsideWorktreeMounts: a cloneDir reached through a SYMLINKED ancestor that resolves inside worktreeRoot is rejected (canonical-path check, not just lexical)", () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  // A symlink whose LEXICAL path is a sibling of worktreeRoot (so the plain resolve()-based
  // check alone would pass it), but whose TARGET is worktreeRoot itself -- so any path built
  // underneath the symlink canonicalizes to somewhere inside worktreeRoot.
  const symlinkAncestor = join(tmpdir(), `sapwood-materializer-symlink-${Math.random().toString(36).slice(2)}`);
  try {
    symlinkSync(worktreeRoot, symlinkAncestor, "dir");
    const cloneDir = join(symlinkAncestor, "clone.git"); // doesn't exist yet -- clone dirs are created fresh
    assert.notEqual(symlinkAncestor, worktreeRoot, "sanity: the lexical paths really are different strings");
    assert.throws(() => assertOutsideWorktreeMounts(cloneDir, worktreeRoot), MaterializerError);
  } finally {
    rmSync(symlinkAncestor, { force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// ── local-config emptiness at clone time ───────────────────────────────────────────────────

test("createPrivateClone: rejects a cloneDir nested inside worktreeRoot BEFORE ever touching git", () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "hello\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const insideCloneDir = join(worktreeRoot, "lane-1", "clone.git");
    assert.rejects(() => createPrivateClone({ sourceRepoDir: shared, cloneDir: insideCloneDir, worktreeRoot }), MaterializerError);
    assert.equal(existsSync(insideCloneDir), false, "no clone was ever attempted");
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("createPrivateClone + assertLocalConfigClean: a fresh bare clone's local config contains ONLY core/remote/branch keys", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "hello\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);

    const cloneDir = join(cloneRoot, "clone.git");
    const clone = await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    assert.equal(clone.dir, cloneDir);
    assert.ok(existsSync(join(cloneDir, "HEAD")), "a real bare repo was created");
    await assert.doesNotReject(() => assertLocalConfigClean(cloneDir));
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("assertLocalConfigClean: fails closed on a filter.* entry (section outside core/remote/branch)", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "hello\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const cloneDir = join(cloneRoot, "clone.git");
    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    // Simulate the paranoid case directly: something wrote a filter entry into the PRIVATE
    // clone's own local config after creation.
    git(cloneDir, ["config", "--local", "filter.evil.smudge", "cat"]);
    await assert.rejects(() => assertLocalConfigClean(cloneDir), MaterializerError);
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

// ── #395 gate② round 3 P2: every git invocation this module makes is now timeout-bounded — ────
// ── verify the bound actually propagates, not just that the option is passed. ─────────────────

test("createPrivateClone (#395 P2): a timeoutMs too tight for a real `git clone` to finish is killed and surfaces as a MaterializerError, not a hang", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const shared = initSharedRepo();
  // #416-class fix: the original version raced a REAL `git clone` subprocess against a 1ms
  // timeout, on the assumption a full clone (fork+exec + git loading the repo) can never finish
  // that fast. That is the same unproven-margin assumption #416 found false for the much cheaper
  // `git rev-parse --verify` call elsewhere in this file — this repo's discipline (#403/#406/#416)
  // is to never rely on real subprocess speed losing a race, no matter how tight the margin looks.
  // Same fix as the sibling tests in this file: point PATH at a fake `git` that fakes ONLY the
  // "clone" subcommand -- this call chain has nothing to reach BEFORE the clone (cloneDir doesn't
  // exist yet, so `createPrivateClone` skips the reuse branch entirely), so there's no earlier
  // real invocation to pass through here; the fake still resolves the real binary for
  // completeness/consistency with the sibling tests.
  const fakeGitBin = mkdtempSync(join(tmpdir(), "sapwood-materializer-fakegit-"));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(shared, "f.txt"), "hello\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const cloneDir = join(cloneRoot, "clone.git");
    const realGit = resolveRealGit();
    writeSelectiveFakeGit(fakeGitBin, ["clone"], realGit);
    process.env.PATH = `${fakeGitBin}:${originalPath ?? ""}`;
    await assert.rejects(
      () =>
        withHangGuard(
          createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot, timeoutMs: 1 }),
          5000,
          "createPrivateClone did not settle within 5000ms — the timeout option is missing or not wired",
        ),
      MaterializerError,
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
    rmSync(fakeGitBin, { recursive: true, force: true });
  }
});

test("assertLocalConfigClean (#395 P2): its own `git config --local --list` read is timeout-bounded — a tight timeoutMs is killed and rejects rather than hanging", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const shared = initSharedRepo();
  // #403-class fix: the original version raced a REAL `git config --local --list` subprocess
  // against a 1ms timeout, on the assumption real git can never finish that fast. On a fast CI
  // runner (warm page/inode cache) it sometimes CAN — the direction called out in the failure
  // report is the opposite of the usual flake: this test fails when the machine is fast, not
  // slow. There is no injectable execFile seam in materializer.ts to stub (pexecFile is a private
  // module-level constant), so instead of racing real git's speed, point PATH at a fake `git`
  // that never returns on its own — the only thing that can produce a rejection is then the
  // `timeout` option itself, deterministically, on any machine at any speed. This mutates the
  // process-global PATH; node:test runs the tests in this file sequentially (no `concurrency`
  // used anywhere in this suite) and each test FILE is its own process, so the mutation can never
  // leak into a concurrently-running test.
  const fakeGitBin = mkdtempSync(join(tmpdir(), "sapwood-materializer-fakegit-"));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(shared, "f.txt"), "hello\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const cloneDir = join(cloneRoot, "clone.git");
    // Real git, generous default timeout, for the SETUP clone (not under test).
    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    // A `git` that never exits on its own -- the read under test can only be resolved by the
    // execFile `timeout` option killing it.
    writeFileSync(join(fakeGitBin, "git"), "#!/bin/sh\nwhile true; do sleep 3600; done\n");
    chmodSync(join(fakeGitBin, "git"), 0o755);
    process.env.PATH = `${fakeGitBin}:${originalPath ?? ""}`;
    // #406-class guard: the assertion below is exactly what proves the `timeout` option is
    // load-bearing -- which also means that if a future change ever drops or breaks that option,
    // the call hangs forever against this never-exiting fake `git` instead of failing. Bound it
    // with a generous (well above any real execution) race so THAT regression fails fast with a
    // named cause instead of wedging the whole suite until the job's outer ceiling kills it. The
    // 20ms timeout under test itself is unaffected -- this only adds a second, much slower race
    // partner.
    await assert.rejects(
      () =>
        withHangGuard(
          assertLocalConfigClean(cloneDir, 20),
          5000,
          "assertLocalConfigClean did not settle within 5000ms — the timeout option is missing or not wired",
        ),
      /unable to read local config/,
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
    rmSync(fakeGitBin, { recursive: true, force: true });
  }
});

test("createPrivateClone (#395 P2): a matching, already-cloned reuse candidate is still timeout-bounded on the rev-parse/remote-url probes and the reuse fetch — a tight timeoutMs falls back to the fresh-clone path (never a hang)", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const shared = initSharedRepo();
  // #416-class fix: the SECOND call below chains several real `git` subprocesses (the reuse-path
  // config-clean/rev-parse/remote-url probes, the reuse fetch, and — on fallback — a fresh clone)
  // all racing a 1ms timeout, on the assumption none of them could ever finish that fast. #416
  // proved that assumption false for `git rev-parse --verify` on a fast/warm-cache CI runner, and
  // this repo's discipline (#403/#406/#416) is to never rely on real subprocess speed losing a
  // race. Same fix as the sibling tests in this file: swap PATH to a SELECTIVE fake `git` (see
  // `writeSelectiveFakeGit`) that only fakes "fetch" and "clone" -- the two operations this test's
  // own name claims are timeout-bounded (the reuse fetch, and its fresh-clone fallback). The
  // earlier reuse-path probes (`assertLocalConfigClean`'s config read, `rev-parse
  // --is-bare-repository`, `remote get-url origin`) all pass through to the REAL git, so this test
  // genuinely walks the whole reuse chain up to the fetch (#416 round-2 P2: the round-1 version
  // hung on the very FIRST probe and never actually reached the fetch it claims to cover) before
  // hitting an operation guaranteed to hang; the fresh-clone fallback is faked too so the tail of
  // the chain stays just as deterministic as the fetch itself, rather than trading one real-timer
  // race for another at the very last step. `REAL_OP_TIMEOUT_MS` (not `1`) bounds the call under
  // test -- see its own doc for why: those three earlier probes are REAL git calls now, and need
  // enough real wall-clock room to actually finish.
  const fakeGitBin = mkdtempSync(join(tmpdir(), "sapwood-materializer-fakegit-"));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(shared, "f.txt"), "hello\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const cloneDir = join(cloneRoot, "clone.git");
    // First call: real git, generous default timeout, creates the clone (the reuse candidate for
    // the next call) -- this is SETUP, not under test.
    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    const realGit = resolveRealGit();
    writeSelectiveFakeGit(fakeGitBin, ["fetch", "clone"], realGit);
    process.env.PATH = `${fakeGitBin}:${originalPath ?? ""}`;
    // Second call: every reuse-path probe runs for real and completes (proving the chain reaches
    // the fetch), then the fetch (and, if reached, the fresh-clone fallback) is guaranteed to hang
    // and be killed by the `timeout` option; either way this must reject rather than hang.
    await assert.rejects(
      () =>
        withHangGuard(
          createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot, timeoutMs: REAL_OP_TIMEOUT_MS }),
          5000,
          "createPrivateClone did not settle within 5000ms — the timeout option is missing or not wired",
        ),
      MaterializerError,
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
    rmSync(fakeGitBin, { recursive: true, force: true });
  }
});

test("materialize (#395 P2): the post-checkout OID verification (`git rev-parse --verify`) is timeout-bounded — a tight timeoutMs surfaces as a { kind: 'failure' } result, never a throw or a hang", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const treeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-tree-"));
  const shared = initSharedRepo();
  // #416-class fix (same technique as the #403 fix just above for assertLocalConfigClean): the
  // original version raced a REAL `git checkout` + `git rev-parse --verify` pair against a 1ms
  // timeout, on the assumption neither could ever finish that fast. On a fast CI runner (warm
  // page/inode cache) `git rev-parse --verify` sometimes CAN — this is the third instance of the
  // banned "real subprocess vs. real timer, single winner asserted" class (#416, actions/runs/
  // 30339000575: `actual: 'materialized', expected: 'failure'`). No injectable execFile seam
  // exists in materializer.ts to stub (pexecFile is a private module-level constant, same as the
  // #403 precedent), so instead of racing real git's speed, point PATH at a SELECTIVE fake `git`
  // (see `writeSelectiveFakeGit`) that fakes ONLY "rev-parse" -- the specific operation this
  // test's name is about. `checkout` passes through to the REAL git, so it genuinely runs and
  // populates `treeDir` (asserted below, cheap to check) BEFORE the post-checkout OID verification
  // is reached; that verification's `rev-parse --verify` is then guaranteed to hang, and the
  // `timeout` option is the only thing that can produce a `{ kind: "failure" }` result,
  // deterministically, on any machine at any speed. (#416 round-2 P2: a round-1 version of this
  // fix faked EVERY invocation, so the checkout step itself never ran for real and a regression
  // that dropped `timeout` from only the `rev-parse --verify` call specifically would have gone
  // undetected -- this version genuinely exercises that exact call.) This mutates the
  // process-global PATH; node:test runs the tests in this file sequentially (no `concurrency` used
  // anywhere in this suite) and each test FILE is its own process, so the mutation can never leak
  // into a concurrently-running test.
  const fakeGitBin = mkdtempSync(join(tmpdir(), "sapwood-materializer-fakegit-"));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(shared, "f.txt"), "hello\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const head = headOid(shared);
    const cloneDir = join(cloneRoot, "clone.git");
    // Real git, generous default timeout, for the SETUP clone (not under test).
    const clone = await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    const realGit = resolveRealGit();
    writeSelectiveFakeGit(fakeGitBin, ["rev-parse"], realGit);
    process.env.PATH = `${fakeGitBin}:${originalPath ?? ""}`;
    // #406-class guard: bound the call under test so a future regression that drops the `timeout`
    // option fails fast with a named cause instead of hanging the whole suite against this
    // never-exiting fake `git`. `REAL_OP_TIMEOUT_MS` (not `1`) is what materialize()'s own
    // `timeoutMs` is bound to -- see that constant's doc: the checkout call ALSO shares this same
    // `timeoutMs` (materialize() has only one), and it is now a REAL passthrough git call that
    // needs real wall-clock room to finish before the (always-hanging) rev-parse is even reached.
    const result = await withHangGuard(
      materialize({ clone, oid: head, treeDir: join(treeRoot, "tree"), timeoutMs: REAL_OP_TIMEOUT_MS }),
      5000,
      "materialize did not settle within 5000ms — the timeout option is missing or not wired",
    );
    assert.equal(result.kind, "failure");
    // Proves the checkout genuinely ran (via the real git passthrough) before the post-checkout
    // OID verification hung -- this is specifically the step the test's own name claims to cover.
    assert.equal(
      readFileSync(join(treeRoot, "tree", "f.txt"), "utf8"),
      "hello\n",
      "the real checkout must have populated treeDir before the post-checkout rev-parse hung",
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(treeRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
    rmSync(fakeGitBin, { recursive: true, force: true });
  }
});

test("assertLocalConfigClean: fails closed on core.hooksPath even though 'core' itself is an allowed section", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "hello\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const cloneDir = join(cloneRoot, "clone.git");
    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    git(cloneDir, ["config", "--local", "core.hooksPath", "/tmp/evil-hooks"]);
    await assert.rejects(() => assertLocalConfigClean(cloneDir), MaterializerError);
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("assertLocalConfigClean: fails closed on core.gitProxy (external-program redirect, same class as hooksPath)", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "hello\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const cloneDir = join(cloneRoot, "clone.git");
    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    git(cloneDir, ["config", "--local", "core.gitProxy", "/tmp/evil-proxy"]);
    await assert.rejects(() => assertLocalConfigClean(cloneDir), MaterializerError);
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("assertLocalConfigClean: fails closed on remote.origin.uploadpack even though 'remote' itself is an allowed section", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "hello\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const cloneDir = join(cloneRoot, "clone.git");
    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    git(cloneDir, ["config", "--local", "remote.origin.uploadpack", "/tmp/evil-uploadpack"]);
    await assert.rejects(() => assertLocalConfigClean(cloneDir), MaterializerError);
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("assertLocalConfigClean: rejects unrecognized remote.origin vcs/proxy/pushurl subkeys", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "hello\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const cloneDir = join(cloneRoot, "clone.git");
    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });

    for (const subkey of ["vcs", "proxy", "pushurl"]) {
      git(cloneDir, ["config", "--local", `remote.origin.${subkey}`, "evil"]);
      await assert.rejects(
        () => assertLocalConfigClean(cloneDir),
        new RegExp(`unrecognized remote subkey "${subkey}"`),
        `remote.origin.${subkey} must fail closed`,
      );
      git(cloneDir, ["config", "--local", "--unset", `remote.origin.${subkey}`]);
    }
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("createPrivateClone: matching clone is reused and fetch-updated", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "one\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "one"]);
    const cloneDir = join(cloneRoot, "clone.git");
    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    writeFileSync(join(cloneDir, "reuse-marker"), "survives only reuse\n");

    writeFileSync(join(shared, "f.txt"), "two\n");
    git(shared, ["commit", "-qam", "two"]);
    const next = headOid(shared);
    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });

    assert.equal(readFileSync(join(cloneDir, "reuse-marker"), "utf8"), "survives only reuse\n");
    assert.equal(git(cloneDir, ["cat-file", "-t", next]).trim(), "commit", "reuse fetches the new source head");
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("createPrivateClone + materialize: an executable post-checkout hook planted in a reused clone stays inert without forcing fallback", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const treeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-tree-"));
  const shared = initSharedRepo();
  const sentinel = join(cloneRoot, "reused-hook-fired.marker");
  try {
    writeFileSync(join(shared, "f.txt"), "one\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "one"]);
    const cloneDir = join(cloneRoot, "clone.git");
    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    writeFileSync(join(cloneDir, "reuse-marker"), "must survive\n");
    writeFileSync(join(cloneDir, "hooks", "post-checkout"), `#!/bin/sh\necho fired > "${sentinel}"\n`);
    chmodSync(join(cloneDir, "hooks", "post-checkout"), 0o755);

    writeFileSync(join(shared, "f.txt"), "two\n");
    git(shared, ["commit", "-qam", "two"]);
    const head = headOid(shared);
    const clone = await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    assert.equal(readFileSync(join(cloneDir, "reuse-marker"), "utf8"), "must survive\n", "hooks-dir payload did not trigger fallback");

    const result = await materialize({ clone, oid: head, treeDir: join(treeRoot, "tree") });
    assert.equal(result.kind, "materialized");
    assert.equal(existsSync(sentinel), false, "reused clone's post-checkout hook was disabled command-locally");
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(treeRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("createPrivateClone + materialize: reuse fetch mirrors a commit reachable only through refs/remotes", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const treeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-tree-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "base\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "base"]);
    const cloneDir = join(cloneRoot, "clone.git");
    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    writeFileSync(join(cloneDir, "reuse-marker"), "must survive\n");

    writeFileSync(join(shared, "remote-only.txt"), "reachable only from refs/remotes/origin/x\n");
    git(shared, ["add", "remote-only.txt"]);
    git(shared, ["commit", "-qm", "remote-only"]);
    const remoteOnly = headOid(shared);
    git(shared, ["update-ref", "refs/remotes/origin/x", remoteOnly]);
    git(shared, ["reset", "--hard", "HEAD^"]);

    const clone = await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    assert.equal(readFileSync(join(cloneDir, "reuse-marker"), "utf8"), "must survive\n", "fixture exercised reuse, not fallback");
    const result = await materialize({ clone, oid: remoteOnly, treeDir: join(treeRoot, "tree") });
    assert.equal(result.kind, "materialized");
    if (result.kind === "materialized") {
      assert.equal(readFileSync(join(result.treeDir, "remote-only.txt"), "utf8"), "reachable only from refs/remotes/origin/x\n");
    }
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(treeRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("createPrivateClone: config-clean is re-asserted on every reuse and assertion failure falls back to fresh clone", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "hello\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const cloneDir = join(cloneRoot, "clone.git");
    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    // Poison the existing clone's config the way a stale/compromised clone might look.
    git(cloneDir, ["config", "--local", "filter.evil.smudge", "cat"]);
    writeFileSync(join(cloneDir, "must-be-removed"), "poisoned clone marker\n");
    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    await assert.doesNotReject(() => assertLocalConfigClean(cloneDir), "the fallback re-clone left no poisoned config");
    assert.equal(existsSync(join(cloneDir, "must-be-removed")), false, "assertion failure discarded the reused clone");
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("createPrivateClone: remote.origin.vcs in a reused clone falls back to a fresh clean clone", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "hello\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const cloneDir = join(cloneRoot, "clone.git");
    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    git(cloneDir, ["config", "--local", "remote.origin.vcs", "evil"]);
    writeFileSync(join(cloneDir, "must-be-removed"), "dirty clone marker\n");

    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });

    assert.equal(existsSync(join(cloneDir, "must-be-removed")), false, "dirty clone was discarded for a fresh clone");
    await assert.doesNotReject(() => assertLocalConfigClean(cloneDir), "the fallback re-clone has clean local config");
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("createPrivateClone: remote.origin.uploadpack is rejected before reuse fetch can execute it", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const shared = initSharedRepo();
  const sentinel = join(cloneRoot, "uploadpack-fired.marker");
  const uploadpack = join(cloneRoot, "evil-uploadpack.sh");
  try {
    writeFileSync(join(shared, "f.txt"), "hello\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const cloneDir = join(cloneRoot, "clone.git");
    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    writeFileSync(uploadpack, `#!/bin/sh\necho fired > "${sentinel}"\nexec git-upload-pack "$@"\n`);
    chmodSync(uploadpack, 0o755);
    git(cloneDir, ["config", "--local", "remote.origin.uploadpack", uploadpack]);
    writeFileSync(join(cloneDir, "must-be-removed"), "dirty clone marker\n");

    await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });

    assert.equal(existsSync(join(cloneDir, "must-be-removed")), false, "dirty clone was discarded for a fresh clone");
    assert.equal(existsSync(sentinel), false, "uploadpack was rejected before reuse fetch executed");
    await assert.doesNotReject(() => assertLocalConfigClean(cloneDir));
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("createPrivateClone: origin mismatch falls back to a fresh clone from the requested source", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const first = initSharedRepo();
  const requested = initSharedRepo();
  try {
    writeFileSync(join(first, "first.txt"), "wrong\n");
    git(first, ["add", "first.txt"]);
    git(first, ["commit", "-qm", "first"]);
    writeFileSync(join(requested, "requested.txt"), "right\n");
    git(requested, ["add", "requested.txt"]);
    git(requested, ["commit", "-qm", "requested"]);
    const cloneDir = join(cloneRoot, "clone.git");
    await createPrivateClone({ sourceRepoDir: first, cloneDir, worktreeRoot });
    writeFileSync(join(cloneDir, "wrong-origin-marker"), "must disappear\n");

    await createPrivateClone({ sourceRepoDir: requested, cloneDir, worktreeRoot });

    assert.equal(existsSync(join(cloneDir, "wrong-origin-marker")), false);
    assert.equal(git(cloneDir, ["remote", "get-url", "origin"]).trim(), requested);
    assert.equal(git(cloneDir, ["cat-file", "-t", headOid(requested)]).trim(), "commit");
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(first, { recursive: true, force: true });
    rmSync(requested, { recursive: true, force: true });
  }
});

// ── adversarial fixture: hooks + filters + replace-refs are all neutralized ────────────────

test("materialize: a shared-clone post-checkout hook and an unconfigured smudge/clean filter never reach the private-clone checkout (positive control proves both mechanisms are real, not just absent by accident)", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const treeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-tree-"));
  const shared = initSharedRepo();
  const sentinel = join(cloneRoot, "hook-fired.marker");
  try {
    // Hooks live in `.git/hooks`, never tracked/committed content -- installed directly into
    // the SHARED repo's git dir, exactly where a producer's own `Bash(git *)` grant could leave
    // one (or a malicious repo could ship one, in the untrusted-source case). `post-checkout`
    // fires even for a pathspec-restricted `checkout <oid> -- .` (git passes flag=0 for "file
    // retrieval" checkouts, but still runs the hook) -- empirically confirmed against this
    // sandbox's git 2.50.1, so this fixture exercises a REAL positive control, not an assumed one.
    const sharedHooksDir = join(shared, ".git", "hooks");
    writeFileSync(join(sharedHooksDir, "post-checkout"), `#!/bin/sh\necho fired > "${sentinel}"\n`);
    chmodSync(join(sharedHooksDir, "post-checkout"), 0o755);

    writeFileSync(join(shared, "secret.txt"), "ORIGINAL\n");
    writeFileSync(join(shared, ".gitattributes"), "secret.txt filter=marker\n");
    git(shared, ["add", "secret.txt", ".gitattributes"]);
    git(shared, ["commit", "-qm", "add secret + attribute (filter unconfigured at commit time)"]);
    const H = headOid(shared);

    // Configure the filter LOCALLY on `shared` only, AFTER the commit -- clean/smudge never
    // touch the already-written blob, only future working-tree materializations.
    git(shared, ["config", "filter.marker.smudge", "sed s/^/SMUDGED-/"]);
    git(shared, ["config", "filter.marker.clean", "cat"]);
    // Positive control: prove BOTH the hook and the filter are REAL by exercising them on
    // `shared`'s own worktree (a plain checkout there must smudge the file AND fire the hook).
    rmSync(sentinel, { force: true });
    rmSync(join(shared, "secret.txt"));
    git(shared, ["checkout", "--", "secret.txt"]);
    assert.equal(
      readFileSync(join(shared, "secret.txt"), "utf8"),
      "SMUDGED-ORIGINAL\n",
      "sanity: the filter mechanism works when configured",
    );
    assert.equal(existsSync(sentinel), true, "sanity: the hook mechanism is real and does fire on a plain checkout");
    rmSync(sentinel, { force: true });

    const cloneDir = join(cloneRoot, "clone.git");
    const clone = await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    // filter.marker.* was never copied into the private clone's local config (bare clone
    // doesn't propagate arbitrary local-config keys) -- assertLocalConfigClean (already run
    // inside createPrivateClone) is the automated proof of that; re-assert directly here too.
    await assert.doesNotReject(() => assertLocalConfigClean(cloneDir));
    // The hook script itself never propagates into a fresh bare clone either -- `git clone`
    // only ever writes non-executable `*.sample` templates into a NEW clone's `hooks/` dir,
    // never copies a source repo's actual hook scripts. Asserted directly, not just implied by
    // the sentinel check below.
    assert.equal(existsSync(join(cloneDir, "hooks", "post-checkout")), false, "the private clone's hooks dir has no post-checkout script");

    const treeDir = join(treeRoot, "tree-1");
    const result = await materialize({ clone, oid: H, treeDir });
    assert.equal(result.kind, "materialized");
    if (result.kind !== "materialized") return;
    assert.equal(
      readFileSync(join(result.treeDir, "secret.txt"), "utf8"),
      "ORIGINAL\n",
      "smudge filter did not run against the private-clone checkout",
    );
    assert.equal(existsSync(sentinel), false, "post-checkout hook did not fire -- it was never present on the private clone to begin with");
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(treeRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("materialize: --no-replace-objects is load-bearing -- a replace ref present on the private clone is ignored by materialize(), but WOULD win without the flag", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const treeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-tree-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "original-content\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "original commit"]);
    const original = headOid(shared);
    writeFileSync(join(shared, "f.txt"), "REPLACED-content\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "replacement commit"]);
    const replacement = headOid(shared);

    const cloneDir = join(cloneRoot, "clone.git");
    const clone = await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    // `git clone` does not fetch refs/replace/* by default -- install the replace ref DIRECTLY
    // on the private clone to test the flag's effect regardless of how such a ref could arrive.
    git(cloneDir, ["replace", original, replacement]);
    assert.equal(
      git(cloneDir, ["show", `${original}:f.txt`]),
      "REPLACED-content\n",
      "sanity: the replace ref is live and would fool a naive read",
    );

    const treeDirIsolated = join(treeRoot, "tree-isolated");
    const result = await materialize({ clone, oid: original, treeDir: treeDirIsolated });
    assert.equal(result.kind, "materialized");
    if (result.kind === "materialized") {
      assert.equal(
        readFileSync(join(result.treeDir, "f.txt"), "utf8"),
        "original-content\n",
        "--no-replace-objects: the replace ref must not apply",
      );
    }

    // Demonstrate the flag is load-bearing: the SAME checkout WITHOUT --no-replace-objects
    // (manually stripped from the pinned invocation) checks out the REPLACED content instead.
    const treeDirUnprotected = join(treeRoot, "tree-unprotected");
    mkdirSync(treeDirUnprotected, { recursive: true });
    execFileSync("git", ["-C", cloneDir, "--work-tree", treeDirUnprotected, "-c", "core.symlinks=false", "checkout", original, "--", "."], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    assert.equal(
      readFileSync(join(treeDirUnprotected, "f.txt"), "utf8"),
      "REPLACED-content\n",
      "without --no-replace-objects the same checkout is fooled by the replace ref -- proves the flag matters",
    );
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(treeRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("materialize: a replace ref present in the SHARED source repo does not propagate to the private clone at all (AC3 literal wording), and materialize() yields the un-replaced content", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const treeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-tree-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "original-content\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "original commit"]);
    const original = headOid(shared);
    writeFileSync(join(shared, "f.txt"), "REPLACED-content\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "replacement commit"]);
    const replacement = headOid(shared);
    // The replace ref lives in the SHARED repo, installed there BEFORE the private clone is
    // ever created -- this is the literal scenario AC3 describes ("a fixture repo with ...
    // replace-refs in the SHARED clone").
    git(shared, ["replace", original, replacement]);
    assert.notEqual(git(shared, ["for-each-ref", "refs/replace"]).trim(), "", "sanity: the replace ref exists in the shared repo");

    const cloneDir = join(cloneRoot, "clone.git");
    const clone = await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    assert.equal(
      git(cloneDir, ["for-each-ref", "refs/replace"]).trim(),
      "",
      "a plain `git clone` never fetches refs/replace/* -- the private clone has none, full stop",
    );

    const treeDir = join(treeRoot, "tree-1");
    const result = await materialize({ clone, oid: original, treeDir });
    assert.equal(result.kind, "materialized");
    if (result.kind === "materialized") {
      assert.equal(readFileSync(join(result.treeDir, "f.txt"), "utf8"), "original-content\n");
    }
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(treeRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

// ── symlink fixture, .git absence, instruction files, manifest ─────────────────────────────

test("materialize: a tracked symlink materializes as a plain regular text file (core.symlinks=false), no .git directory in the tree, instruction files included, manifest recorded", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const treeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-tree-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "target-file-contents\n");
    execFileSync("ln", ["-s", "f.txt", "link.txt"], { cwd: shared });
    mkdirSync(join(shared, ".claude", "rules"), { recursive: true });
    writeFileSync(join(shared, "CLAUDE.md"), "# repo instructions\n");
    writeFileSync(join(shared, ".claude", "rules", "x.md"), "rule x\n");
    git(shared, ["add", "f.txt", "link.txt", "CLAUDE.md", ".claude/rules/x.md"]);
    git(shared, ["commit", "-qm", "add symlink + instruction files"]);
    const H = headOid(shared);

    const cloneDir = join(cloneRoot, "clone.git");
    const clone = await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    const treeDir = join(treeRoot, "tree-1");
    const result = await materialize({ clone, oid: H, treeDir });

    assert.equal(result.kind, "materialized");
    if (result.kind !== "materialized") return;

    // Symlink materializes as a PLAIN regular file, not an OS symlink.
    const linkStat = lstatSync(join(result.treeDir, "link.txt"));
    assert.equal(linkStat.isSymbolicLink(), false, "no real OS symlink was created");
    assert.equal(linkStat.isFile(), true);
    assert.equal(readFileSync(join(result.treeDir, "link.txt"), "utf8"), "f.txt", "symlink target text materializes as plain content");

    // No `.git` anywhere in the tree.
    assert.equal(existsSync(join(result.treeDir, ".git")), false);

    // Instruction files INCLUDED (D7) -- not excluded, not specially transformed.
    assert.equal(readFileSync(join(result.treeDir, "CLAUDE.md"), "utf8"), "# repo instructions\n");
    assert.equal(readFileSync(join(result.treeDir, ".claude", "rules", "x.md"), "utf8"), "rule x\n");

    // Tree manifest: every file present, sorted, correctly hashed.
    const paths = result.manifest.map((m) => m.path).sort();
    assert.deepEqual(paths, [".claude/rules/x.md", "CLAUDE.md", "f.txt", "link.txt"]);
    const claudeEntry = result.manifest.find((m) => m.path === "CLAUDE.md");
    assert.ok(claudeEntry);
    const expectedHash = createHash("sha256").update("# repo instructions\n").digest("hex");
    assert.equal(claudeEntry?.contentHash, expectedHash);
    assert.equal(result.oid, H);
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(treeRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

// ── OID mismatch -> failure, never a silently wrong tree ───────────────────────────────────

test("materialize: rejects a non-full-length oid up front, before touching git at all", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const treeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-tree-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "x\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const cloneDir = join(cloneRoot, "clone.git");
    const clone = await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    const treeDir = join(treeRoot, "tree-short-oid");
    const result = await materialize({ clone, oid: headOid(shared).slice(0, 7), treeDir });
    assert.equal(result.kind, "failure");
    assert.equal(existsSync(join(treeDir, "f.txt")), false, "nothing was checked out for an ambiguous oid");
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(treeRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("materialize: checkout OID mismatch (post-checkout verification resolves a DIFFERENT oid) -> failure, never a silently wrong tree", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const treeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-tree-"));
  const shimDir = mkdtempSync(join(tmpdir(), "sapwood-materializer-gitshim-"));
  const shared = initSharedRepo();
  const oldPath = process.env.PATH;
  try {
    writeFileSync(join(shared, "f.txt"), "x\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const cloneDir = join(cloneRoot, "clone.git");
    const clone = await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    const H = headOid(shared);

    // A `git` shim FIRST on PATH: delegates every invocation to the REAL git, except
    // `rev-parse --verify`, which it answers with a DIFFERENT (bogus) oid -- simulating a
    // corrupted/mismatched post-checkout verification without needing a real repo corruption.
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bogusOid = "d".repeat(40);
    writeFileSync(
      join(shimDir, "git"),
      `#!/usr/bin/env bash\nif [[ "$*" == *"rev-parse"*"--verify"* ]]; then\n  echo "${bogusOid}"\n  exit 0\nfi\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${shimDir}:${oldPath}`;

    const treeDir = join(treeRoot, "tree-mismatch");
    const result = await materialize({ clone, oid: H, treeDir });
    assert.equal(result.kind, "failure");
    if (result.kind === "failure") assert.match(result.reason, /mismatch/i);
  } finally {
    process.env.PATH = oldPath;
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(treeRoot, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("materialize: checkout of a well-formed but nonexistent oid fails cleanly (never falls back to HEAD or any other tree)", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const treeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-tree-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "x\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const cloneDir = join(cloneRoot, "clone.git");
    const clone = await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    const treeDir = join(treeRoot, "tree-nonexistent");
    const result = await materialize({ clone, oid: "f".repeat(40), treeDir });
    assert.equal(result.kind, "failure");
    assert.equal(existsSync(join(treeDir, "f.txt")), false);
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(treeRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("materialize: refuses to write onto an already-populated treeDir", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const treeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-tree-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "x\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const cloneDir = join(cloneRoot, "clone.git");
    const clone = await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
    const treeDir = join(treeRoot, "tree-nonempty");
    mkdirSync(treeDir, { recursive: true });
    writeFileSync(join(treeDir, "pre-existing.txt"), "already here\n");
    const result = await materialize({ clone, oid: headOid(shared), treeDir });
    assert.equal(result.kind, "failure");
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(treeRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

// ── materialize() never THROWS (rejects) -- every fs error converts to a failure result ─────

test("materialize: never rejects even when the pre-checkout treeDir probe itself throws -- treeDir pre-exists as a REGULAR FILE, not a directory (readdirSync/mkdirSync both throw ENOTDIR)", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-clone-"));
  const treeRoot = mkdtempSync(join(tmpdir(), "sapwood-materializer-tree-"));
  const shared = initSharedRepo();
  try {
    writeFileSync(join(shared, "f.txt"), "x\n");
    git(shared, ["add", "f.txt"]);
    git(shared, ["commit", "-qm", "init"]);
    const cloneDir = join(cloneRoot, "clone.git");
    const clone = await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });

    // treeDir's PATH already exists, but as a plain file, not a directory -- existsSync(dir) is
    // true, so materialize() reaches readdirSync(dir), which throws ENOTDIR (a directory-only
    // syscall against a regular file). Before this fix that throw was uncaught and the returned
    // promise rejected, breaking the "never throws" contract design #279 §6 relies on.
    const treeDir = join(treeRoot, "tree-is-a-file");
    mkdirSync(treeRoot, { recursive: true });
    writeFileSync(treeDir, "this is a file, not a directory\n");

    const result = await materialize({ clone, oid: headOid(shared), treeDir });
    assert.equal(result.kind, "failure");
    if (result.kind === "failure") assert.match(result.reason, /treeDir setup/);
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(treeRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});
