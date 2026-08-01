// materializer.ts (#284, design #279 §3, D6+D7) — the engine's PRIVATE-CLONE review-tree
// materializer. The reviewer must see a faithful tree of the reviewed commit WITHOUT ever
// touching the shared repository: the shared repo's `.git/config` is producer-writable from
// worker worktrees via `Bash(git *)` (worker.ts grants that tool; the guard hook scopes WRITE
// tools to the worktree, not `git` itself), so hooks/filters/replace-refs configured there are
// a live execution surface (#65's clean-filter RCE class). This module is the load-bearing
// defense D6 settled on AFTER an earlier custom-plumbing-extractor design (ls-tree/cat-file,
// D2) was superseded: with an ENGINE-PRIVATE clone (never fetched into a worker-reachable path,
// local config asserted empty) plus environment config isolation, a STOCK `git checkout` has no
// code-execution surface left to close — the custom extractor bought near-zero extra security
// for a lot of machinery. See docs/design/279-engine-review-agent.md §3/§3a for the full
// adjudication (D6, D7) this module implements.
//
// Two structural guarantees, both asserted (not just documented) at the seams below:
//   1. `assertOutsideWorktreeMounts` — the private clone's directory is provably disjoint from
//      every worker worktree mount (worker.ts's own `<worktreeRoot>/<lane>` convention), checked
//      BOTH lexically (`resolve()`, normalizes `..`) AND canonically (symlinks dereferenced via
//      `realpathSync` on the nearest existing ancestor — code review round 2, P2: `resolve()`
//      alone does not dereference symlinks, so a cloneDir reached through a symlinked ancestor
//      pointing into `worktreeRoot` would otherwise pass). A worker's `Bash(git *)` grant is
//      scoped to ITS OWN worktree by the guard hook; a clone living outside that whole tree is
//      simply never in a worker's reach to begin with.
//   2. `assertLocalConfigClean` — after cloning, the private clone's `git config --local --list`
//      is asserted to contain ONLY the sections a plain `git clone --bare` is known to write
//      (core/remote/branch), with a small core denylist for specific dangerous subkeys (hooks
//      path, filter/proxy/alternates helpers, ssh/askpass overrides) and a strict remote subkey
//      allowlist. Anything outside the allowlisted sections
//      fails closed — this is the "local config asserted EMPTY at clone time" AC, read as "empty
//      of anything beyond the clone's own inert bookkeeping." The core denylist is a FIXED,
//      known-dangerous-keys list, not a claim of exhaustively covering every future git config
//      key that could ever gain exec/network capability. The remote section instead permits only
//      clone bookkeeping known to be inert; every unrecognized remote subkey fails closed.
//
// Instruction files (`CLAUDE.md`, `.claude/**`) are INCLUDED in the materialized tree — D7
// reverses the earlier exclusion. There is no filtering/exclusion logic anywhere in this module
// by design: a stock `checkout <oid> -- .` takes everything the commit tracks, full stop. The
// authority-channel risk D7 accepts in exchange is closed by a DIFFERENT, cheaper mechanism
// (§3a's instruction-path change escalation, issue #284's sibling E6) — not by this module.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

// #395 (gate② P3): default ceiling for the fetch/clone/checkout `git` invocations below when a
// caller doesn't supply its own (PrivateCloneOptions.timeoutMs / MaterializeOptions.timeoutMs) —
// same 60s default as gh.ts's own DEFAULT_GH_TIMEOUT_MS, for the same reason (a dead socket/hung
// upstream must fail toward retry, never wedge the caller forever).
const DEFAULT_GIT_TIMEOUT_MS = 60_000;

/** Every failure this module produces is a `MaterializerError` (thrown by the clone-setup
 *  helpers) or a `{ kind: "failure" }` result (returned by `materialize`, never thrown — the
 *  caller drives one review attempt per head and maps a failure straight onto the engine's
 *  existing `unavailable` outcome, design #279 §6: "All setup failures (materialize failure
 *  included) map to `unavailable`."). Nothing in this module ever falls back to a guessed or
 *  partial tree — every error path is an explicit, named failure. */
export class MaterializerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterializerError";
  }
}

/** `parent`-relative containment check: true iff `child` is STRICTLY inside `parent` (equal
 *  paths are not "within" — callers combine this with an explicit equality check). Both sides
 *  are `resolve()`d first so relative inputs and trailing slashes can't produce a false
 *  negative. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Canonicalizes `p` by `realpathSync`-ing its NEAREST EXISTING ancestor (walking up via
 *  `dirname`) and re-joining whatever suffix doesn't exist yet. Needed because the private
 *  clone dir itself never exists at the time `assertOutsideWorktreeMounts` runs (it's created
 *  fresh, see `createPrivateClone`'s own doc) -- `realpathSync` alone would throw ENOENT on it,
 *  so this walks up to the first ancestor that DOES exist, resolves symlinks THERE, and reapplies
 *  the non-existent tail lexically. Degrades to the plain `resolve()`d path if nothing in the
 *  chain exists (the filesystem root always exists in practice, so this is unreachable in
 *  practice, not a silent weakening). */
function canonicalize(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return resolve(p); // reached the top with nothing existing -- give up cleanly
    tail.unshift(basename(cur));
    cur = parent;
  }
  const real = realpathSync(cur);
  return tail.length === 0 ? real : join(real, ...tail);
}

/** #284 AC: "Bare clone provably outside all worker worktree mounts." `worktreeRoot` is
 *  worker.ts's OWN convention (`<worktreeRoot>/<laneName>`, default `<cwd>/.claude/worktrees` —
 *  see `WorkerSupervisor`'s `worktreeRoot` default) — every worker worktree lives under it, so
 *  disjointness from `worktreeRoot` is disjointness from every individual worktree. Checked
 *  BOTH directions: a clone nested inside the worktree root is obviously reachable, and a
 *  worktree root nested inside the clone dir would put every worker's mount inside the
 *  "private" tree, which is exactly backwards. Equality is rejected too.
 *
 *  TWO passes, lexical then canonical (code review round 2, P2): the plain `resolve()`d paths
 *  are checked first (cheap, catches the common case and needs no filesystem access beyond what
 *  `resolve()` itself does), then the SAME check is repeated against `realpathSync`-canonicalized
 *  paths, so a cloneDir reached through a symlinked ancestor that resolves into `worktreeRoot`
 *  is caught too. In production `cloneDir` is engine-trusted config, not producer-controlled, so
 *  this second pass is hardening rather than closing a live exploit -- but AC1 says "provably
 *  outside" and canonical-path checking is cheap enough to just do. */
export function assertOutsideWorktreeMounts(cloneDir: string, worktreeRoot: string): void {
  const a = resolve(cloneDir);
  const b = resolve(worktreeRoot);
  if (a === b || isWithin(b, a) || isWithin(a, b)) {
    throw new MaterializerError(
      `private clone dir "${cloneDir}" is not structurally disjoint from the worker worktree root "${worktreeRoot}" ` +
        "-- the clone must live entirely outside every worker's mount",
    );
  }
  const canonA = canonicalize(cloneDir);
  const canonB = canonicalize(worktreeRoot);
  if (canonA === canonB || isWithin(canonB, canonA) || isWithin(canonA, canonB)) {
    throw new MaterializerError(
      `private clone dir "${cloneDir}" resolves through a symlink to a path that is not structurally disjoint from ` +
        `the worker worktree root "${worktreeRoot}" -- canonical paths "${canonA}" vs "${canonB}"`,
    );
  }
}

/** Default engine-private clone location: `data/` is the SAME convention `stateDir` uses
 *  (`worker.ts`'s `WorkerSupervisor.dir` default `<cwd>/data/sessions/state`) -- workers have no
 *  mount under `data/` at all (existing structural guarantee this repo already relies on), which
 *  is a stronger property than mere path disjointness from `worktreeRoot`. `assertOutsideWorktreeMounts`
 *  is still run against whatever directory is actually passed in -- this default is a safe
 *  starting point, not a substitute for the assertion. */
export function defaultPrivateCloneDir(cwd: string = process.cwd()): string {
  return join(cwd, "data", "review", "clone.git");
}

/** Mirrors `WorkerSupervisor`'s own `worktreeRoot` default exactly (worker.ts) -- the convention
 *  this module's disjointness check is measured against. */
export function defaultWorktreeRoot(cwd: string = process.cwd()): string {
  return join(cwd, ".claude", "worktrees");
}

/** Local-config sections a plain `git clone --bare` is ever known to write (empirically verified
 *  against this repo's own git). Anything OUTSIDE this set -- `filter.*`, `credential.*`,
 *  `http.*`, `include*`, `alias.*`, `hooks.*` (not a real section, but `core.hooksPath` is caught
 *  below), `protocol.*`, `receive.*`, `uploadpack.*` -- fails closed. This is an ALLOWLIST, not a
 *  denylist, on purpose: a security-sensitive assertion should reject anything unrecognized, not
 *  just anything on a known-bad list. */
const ALLOWED_LOCAL_CONFIG_SECTIONS = new Set(["core", "remote", "branch"]);

/** Even WITHIN the allowed `core` section, a fixed list of specific subkeys are dangerous enough
 *  (they redirect git to run other programs, or leak credentials) to deny explicitly. This is a
 *  known-bad list, not a claim of covering every current or future exec/network-capable `core.*`
 *  key -- the section-level allowlist above is the primary defense; this narrows further within
 *  it. `alternateRefsCommand`/`gitProxy` (code review round 2, P3) round out the set: both
 *  invoke an external program the same way `hooksPath`/`sshCommand`/`askPass` do. */
const DENIED_CORE_SUBKEYS = new Set([
  "hookspath",
  "fsmonitor",
  "sshcommand",
  "pager",
  "editor",
  "attributesfile",
  "excludesfile",
  "askpass",
  "alternaterefscommand",
  "gitproxy",
]);

/** Within the allowed `remote` section, permit only the inert bookkeeping subkeys written by a
 *  plain clone: the source URL and fetch refspec. Empirically, this repo's installed git writes
 *  only `remote.origin.url` for a fresh local `git clone --bare`; `fetch` is the standard benign
 *  data-only refspec key. Everything else -- including uploadpack/receivepack/vcs/proxy/pushurl
 *  -- is unrecognized and fails closed. Checked against the LAST dot-separated segment since a
 *  remote key's shape is `remote.<name>.<subkey>`. */
const ALLOWED_REMOTE_SUBKEYS = new Set(["url", "fetch"]);

/** #284 AC: "local-config emptiness asserted at clone time." Reads `git config --local --list`
 *  from the private clone and fails closed on anything outside the allowlist above. Called after
 *  every fresh clone and both before and after every reuse fetch: reuse is never treated as
 *  evidence that config stayed clean between materialization attempts. */
export async function assertLocalConfigClean(cloneDir: string, timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await pexecFile("git", ["-C", cloneDir, "config", "--local", "--list"], { env: gitIsolationEnv(), timeout: timeoutMs }));
  } catch (err) {
    // An unreadable local config is itself a failure, not a silent pass -- a private clone this
    // module can't even introspect can't be asserted clean.
    throw new MaterializerError(`unable to read local config of private clone at "${cloneDir}": ${(err as Error).message}`);
  }
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    const key = (eq === -1 ? line : line.slice(0, eq)).trim();
    if (!key) continue;
    const dot = key.indexOf(".");
    const section = (dot === -1 ? key : key.slice(0, dot)).toLowerCase();
    if (!ALLOWED_LOCAL_CONFIG_SECTIONS.has(section)) {
      throw new MaterializerError(
        `private clone local config at "${cloneDir}" has an unexpected section "${section}" (key "${key}") -- ` +
          "expected only core/remote/branch, the sections a plain `git clone --bare` writes; anything else " +
          "(filter/credential/http/include/alias/protocol/receive/uploadpack/...) fails closed",
      );
    }
    // Last dot-separated segment: for `core.<subkey>` this is the same as everything after the
    // first dot, but `remote.<name>.<subkey>` needs the LAST segment specifically (the middle
    // segment is the remote's own name, not part of the subkey).
    const lastDot = key.lastIndexOf(".");
    const lastSegment = (lastDot === -1 ? "" : key.slice(lastDot + 1)).toLowerCase();
    if (section === "core" && DENIED_CORE_SUBKEYS.has(lastSegment)) {
      throw new MaterializerError(
        `private clone local config at "${cloneDir}" sets dangerous "core.${lastSegment}" -- refusing to use this clone`,
      );
    }
    if (section === "remote" && !ALLOWED_REMOTE_SUBKEYS.has(lastSegment)) {
      throw new MaterializerError(
        `private clone local config at "${cloneDir}" has unrecognized remote subkey "${lastSegment}" (key "${key}") -- ` +
          "expected only remote.*.url/fetch; refusing to use this clone",
      );
    }
  }
}

/** Strip-then-set env isolation, mirroring `workerCredentialFreeEnv`'s own idiom (worker.ts) --
 *  an INHERITED `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` is stripped first so it can never survive
 *  to override the isolation this module forces below, regardless of what the calling process's
 *  own environment happens to carry. `/dev/null` is git's own documented way (since 2.32) to say
 *  "read config from nowhere" -- git treats it as a config file with zero entries, never an
 *  error. Every git invocation in this module goes through this -- clone, config read, checkout,
 *  and the post-checkout OID verification -- there is no isolated-vs-not code path to forget. */
function gitIsolationEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.toUpperCase().startsWith("GIT_CONFIG_")) continue;
    env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  return env;
}

export interface GitInvocation {
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
}

/** Pure builder, unit-pinned (#284 AC: "exact invocation env/flags pinned by tests"). `--no-hardlinks`
 *  is deliberate for a LOCAL source path: git's default local-clone optimization hardlinks
 *  objects, which would leave the private clone's object store sharing inodes with the shared
 *  repo's -- not a correctness bug (git objects are content-addressed and never mutated in
 *  place), but it blurs the "private" story this module exists to keep clean; `--no-hardlinks`
 *  forces independent copies for a few extra syscalls. */
export function buildCloneInvocation(sourceRepoDir: string, cloneDir: string, baseEnv: NodeJS.ProcessEnv = process.env): GitInvocation {
  return {
    args: ["clone", "--bare", "--no-hardlinks", resolve(sourceRepoDir), cloneDir],
    env: gitIsolationEnv(baseEnv),
  };
}

/** Reuse keeps the same config/environment isolation as the fresh-clone path, disables hooks
 *  command-locally, and names both the source and a full mirror refspec explicitly instead of
 *  trusting mutable local config. */
export function buildFetchInvocation(cloneDir: string, baseEnv: NodeJS.ProcessEnv = process.env): GitInvocation {
  return {
    args: ["-C", cloneDir, "-c", "core.hooksPath=/dev/null", "fetch", "--prune", "origin", "+refs/*:refs/*"],
    env: gitIsolationEnv(baseEnv),
  };
}

/** Pure builder, unit-pinned (#284 AC). Exact shape design #279 §3 specifies: `-C <clone>
 *  --work-tree=<tmpdir> checkout <H> -- .` under `GIT_CONFIG_GLOBAL=/dev/null
 *  GIT_CONFIG_SYSTEM=/dev/null`, `--no-replace-objects`, `-c core.symlinks=false`, and
 *  `-c core.hooksPath=/dev/null`. All four controls are load-bearing and independently tested
 *  (dropping any one fails a pinned test AND,
 *  for `--no-replace-objects`/`core.symlinks=false`, a behavioral fixture test): dropping
 *  `--no-replace-objects` would let a `refs/replace/*` substitution silently swap in different
 *  content for the SAME oid; dropping `core.symlinks=false` would let a tracked symlink
 *  materialize as a real OS symlink (a read-containment escape hatch for anything walking the
 *  tree later); dropping the hooks override would let an attacker-controlled reused clone run
 *  `post-checkout`; dropping the env isolation would let an ambient global/system git config
 *  inject hooks/filters this checkout would otherwise never look at. */
export function buildCheckoutInvocation(
  cloneDir: string,
  treeDir: string,
  oid: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): GitInvocation {
  return {
    args: [
      "-C",
      cloneDir,
      "--work-tree",
      treeDir,
      "--no-replace-objects",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.symlinks=false",
      "checkout",
      oid,
      "--",
      ".",
    ],
    env: gitIsolationEnv(baseEnv),
  };
}

export interface PrivateClone {
  readonly dir: string;
}

export interface PrivateCloneOptions {
  /** The engine's own checkout of the repo -- NEVER a worker's worktree. In production this is
   *  the same repo the engine process itself runs from (`process.cwd()`), which is exactly the
   *  "shared repository" whose `.git/config` is producer-writable -- that's fine, because we
   *  only ever READ from it here (a `git clone`), and everything downstream operates on the
   *  fresh, isolated copy, never the source. */
  sourceRepoDir: string;
  /** Where the private bare clone lives. Must be disjoint from `worktreeRoot` -- asserted, not
   *  assumed (see `assertOutsideWorktreeMounts`). */
  cloneDir: string;
  /** Worker worktree mount root (worker.ts's own convention) the clone is checked against. */
  worktreeRoot: string;
  /** #395 (gate② P3): hard ceiling on the fetch/clone `git` invocations below — same rationale
   *  as gh.ts's own bound (a dead socket/hung upstream must never wedge the caller forever).
   *  Default: DEFAULT_GIT_TIMEOUT_MS. Production callers (review/production.ts) pass
   *  cfg.liveness.forgeCallTimeoutMs explicitly, so the two external-process bounds share one
   *  user-tunable knob rather than a second, parallel one for this module alone. */
  timeoutMs?: number;
}

/** Reuses a matching engine-private bare clone when every assertion succeeds. The fast path is
 *  intentionally disposable: corrupt repo, wrong origin, dirty local config, or fetch failure
 *  all fall back to rm + the original fresh-clone path. Correctness therefore never depends on
 *  reuse, and D6's local-config assertion is repeated before every reused fetch rather than
 *  trusting a clone merely because this module created it on an earlier attempt. */
export async function createPrivateClone(opts: PrivateCloneOptions): Promise<PrivateClone> {
  const cloneDir = resolve(opts.cloneDir);
  const sourceRepoDir = resolve(opts.sourceRepoDir);
  assertOutsideWorktreeMounts(cloneDir, opts.worktreeRoot);
  if (existsSync(cloneDir)) {
    try {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
      await assertLocalConfigClean(cloneDir, timeoutMs);
      const probe = await pexecFile("git", ["-C", cloneDir, "rev-parse", "--is-bare-repository"], {
        env: gitIsolationEnv(),
        timeout: timeoutMs,
      });
      if (probe.stdout.trim() !== "true") throw new MaterializerError(`existing private clone at "${cloneDir}" is not bare`);
      const origin = await pexecFile("git", ["-C", cloneDir, "remote", "get-url", "origin"], {
        env: gitIsolationEnv(),
        timeout: timeoutMs,
      });
      if (origin.stdout.trim() !== sourceRepoDir) {
        throw new MaterializerError(`existing private clone origin does not match "${sourceRepoDir}"`);
      }
      const { args, env } = buildFetchInvocation(cloneDir);
      await pexecFile("git", args, { env, timeout: timeoutMs });
      await assertLocalConfigClean(cloneDir, timeoutMs);
      return { dir: cloneDir };
    } catch {
      // Optimization only: every doubt discards the clone and resumes at the proven fresh path.
    }
  }
  if (existsSync(cloneDir)) rmSync(cloneDir, { recursive: true, force: true });
  mkdirSync(dirname(cloneDir), { recursive: true });

  const { args, env } = buildCloneInvocation(sourceRepoDir, cloneDir);
  try {
    await pexecFile("git", args, { env, timeout: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS });
  } catch (err) {
    throw new MaterializerError(`private clone of "${opts.sourceRepoDir}" into "${cloneDir}" failed: ${(err as Error).message}`);
  }

  await assertLocalConfigClean(cloneDir, opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);
  return { dir: cloneDir };
}

export interface TreeManifestEntry {
  /** Repo-relative, POSIX-separated path (stable across platforms). */
  path: string;
  /** sha256 hex digest of the materialized file's raw bytes. */
  contentHash: string;
}

export type MaterializeResult =
  | { kind: "materialized"; treeDir: string; oid: string; manifest: TreeManifestEntry[] }
  | { kind: "failure"; reason: string };

const FULL_OID = /^[0-9a-f]{40}$/i;

/** Recursively hashes every regular file under `dir` into a sorted, deterministic manifest
 *  (#284 AC: "tree manifest (file list + content hash) recorded"). Directories are not listed
 *  (git doesn't track them either); a former-symlink materializes as a plain regular file
 *  (`core.symlinks=false`, see `buildCheckoutInvocation`) so it is hashed exactly like any other
 *  tracked file -- there is no separate "symlink" case here by construction. `withFileTypes` +
 *  `recursive` requires Node 20.17+/22.2+, well under this package's floor (Node >=24). */
function buildTreeManifest(dir: string): TreeManifestEntry[] {
  const entries: TreeManifestEntry[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!d.isFile()) continue;
    const parentPath = (d.parentPath as string | undefined) ?? dir;
    const abs = join(parentPath, d.name);
    const relPath = relative(dir, abs).split(sep).join("/");
    entries.push({ path: relPath, contentHash: createHash("sha256").update(readFileSync(abs)).digest("hex") });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

export interface MaterializeOptions {
  clone: PrivateClone;
  /** Full 40-hex commit sha -- an abbreviated or symbolic ref is rejected up front (fail-closed
   *  before ever touching git: this module's caller is expected to hold an unambiguous oid, and
   *  a short/ambiguous ref is exactly the kind of thing that could resolve to something other
   *  than what the caller intended). */
  oid: string;
  /** Destination directory for the materialized tree. Must not already exist with content --
   *  this module never merges onto an existing tree. */
  treeDir: string;
  /** #395 (gate② P3): hard ceiling on the checkout `git` invocation below — see
   *  PrivateCloneOptions.timeoutMs's own doc for the full rationale. Default:
   *  DEFAULT_GIT_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** #284's core operation: private-clone checkout into a plain source tree, per design #279 §3.
 *  Every failure path returns `{ kind: "failure" }` rather than throwing OR silently returning a
 *  partial/wrong tree -- "materialization FAILURE, never a silently wrong tree" is the AC this
 *  function's structure is built around: an oid that fails format validation, a checkout that
 *  exits non-zero, a post-checkout OID that doesn't verify, or a stray `.git` entry in the
 *  result all short-circuit to `failure` before a manifest is ever built. This is an ABSOLUTE
 *  contract (code review round 2, P2: design #279 §6 relies on it verbatim -- "All setup
 *  failures (materialize failure included) map to `unavailable`", which only holds if this
 *  function's returned PROMISE never rejects) -- every fs call that could throw (the pre-checkout
 *  treeDir probe/creation, and `buildTreeManifest`'s directory walk + reads) is wrapped in its
 *  own try/catch below; only `existsSync` (which never throws by Node's own contract) is left
 *  bare. */
export async function materialize(opts: MaterializeOptions): Promise<MaterializeResult> {
  const { clone, oid, treeDir } = opts;
  if (!FULL_OID.test(oid)) {
    return { kind: "failure", reason: `oid must be a full 40-hex commit sha, got ${JSON.stringify(oid)}` };
  }
  const dir = resolve(treeDir);
  try {
    if (existsSync(dir) && readdirSync(dir).length > 0) {
      return { kind: "failure", reason: `treeDir "${dir}" already exists and is not empty` };
    }
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    // e.g. `dir` already exists as a REGULAR FILE (readdirSync/mkdirSync both throw ENOTDIR), or
    // a permissions error -- a thrown fs error here must not escape this function as a rejection.
    return { kind: "failure", reason: `treeDir setup for "${dir}" failed: ${(err as Error).message}` };
  }

  const { args, env } = buildCheckoutInvocation(clone.dir, dir, oid);
  try {
    await pexecFile("git", args, { env, timeout: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS });
  } catch (err) {
    return { kind: "failure", reason: `checkout of ${oid} failed: ${(err as Error).message}` };
  }

  // Post-materialization OID verification (#284 AC: "checkout OID mismatch -> materialization
  // failure"). Resolved independently against the PRIVATE clone and compared byte-for-byte
  // against the requested oid -- catches a corrupted/mismatched object database or a checkout
  // that silently resolved to something other than what was asked for. This is the one place
  // this module re-invokes git WITHOUT going through buildCheckoutInvocation (there is nothing
  // to check out here), but it uses the exact same `gitIsolationEnv`.
  let resolvedOid: string;
  try {
    const { stdout } = await pexecFile("git", ["-C", clone.dir, "rev-parse", "--verify", `${oid}^{commit}`], {
      env: gitIsolationEnv(),
      timeout: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    });
    resolvedOid = stdout.trim();
  } catch (err) {
    return { kind: "failure", reason: `post-checkout oid verification of ${oid} failed: ${(err as Error).message}` };
  }
  if (resolvedOid.toLowerCase() !== oid.toLowerCase()) {
    return { kind: "failure", reason: `checkout OID mismatch: requested ${oid}, private clone resolved ${resolvedOid}` };
  }

  // D1 (static-only review sessions) + this module's own contract: no `.git` may land in the
  // materialized tree -- the review session gets a plain source tree, never a repository it
  // could run further git commands against.
  if (existsSync(join(dir, ".git"))) {
    return { kind: "failure", reason: `materialized tree at "${dir}" unexpectedly contains a .git entry` };
  }

  let manifest: TreeManifestEntry[];
  try {
    manifest = buildTreeManifest(dir);
  } catch (err) {
    // A file vanishing mid-hash, an unreadable entry, or any other fs error while walking the
    // checked-out tree -- same "never throws" contract as every other step above.
    return { kind: "failure", reason: `tree manifest of "${dir}" failed: ${(err as Error).message}` };
  }

  return { kind: "materialized", treeDir: dir, oid, manifest };
}

// ── #499: external-head fallback ────────────────────────────────────────────────────────────

/** #499: failure signatures that mean "the object database does not have this oid" — as opposed
 *  to a timeout, a bad treeDir, or an OID-verification mismatch. Only this class is worth a
 *  remedial remote fetch; everything else fails exactly as before. */
export const MISSING_OBJECT_SIGNATURE = /unable to read tree|bad object|not a valid object|missing object/i;

/** #499: pure builder, pinned like its siblings above. Fetches every branch head and every PR
 *  head from `remoteUrl` into a private `refs/external/*` namespace — by REF, not by raw sha,
 *  because sha-in-want depends on server config while advertised refs always resolve, and the
 *  head we are missing is by construction a branch or PR head on the forge. The namespace keeps
 *  the mirror refspec's `--prune` (buildFetchInvocation) from ever fighting these refs' objects
 *  mid-materialization: the remedial fetch happens immediately before the retry checkout, and a
 *  later prune only unpins objects for gc, which cannot un-materialize an already-built tree. */
export function buildExternalHeadFetchInvocation(
  cloneDir: string,
  remoteUrl: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): GitInvocation {
  return {
    args: [
      "-C",
      cloneDir,
      "-c",
      "core.hooksPath=/dev/null",
      "fetch",
      "--no-tags",
      remoteUrl,
      "+refs/heads/*:refs/external/heads/*",
      "+refs/pull/*/head:refs/external/pull/*",
    ],
    env: gitIsolationEnv(baseEnv),
  };
}

/** #499: the source repo's `origin` URL (the forge remote the lanes push to), or null when there
 *  is no usable origin — never throws. Read from the engine checkout's own config, which is the
 *  same producer-writable surface `createPrivateClone` already reads (see
 *  PrivateCloneOptions.sourceRepoDir's doc): safe for the same reason — fetched objects are
 *  content-addressed and `materialize` verifies the checked-out OID, so a redirected origin can
 *  refuse us objects but cannot substitute different content for the requested head. */
export async function sourceOriginUrl(sourceRepoDir: string, timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS): Promise<string | null> {
  try {
    const { stdout } = await pexecFile("git", ["-C", resolve(sourceRepoDir), "remote", "get-url", "origin"], {
      env: gitIsolationEnv(),
      timeout: timeoutMs,
    });
    const url = stdout.trim();
    return url === "" ? null : url;
  } catch {
    return null;
  }
}

/** #499: `materialize`, plus one bounded remedial step for the wedge class hit live 2026-08-01 —
 *  a PR head created OUTSIDE this machine (GitHub update-branch, a human pushing from another
 *  clone, a fork PR) is absent from the local object store, so the private clone (whose origin
 *  is the LOCAL repo) can never check it out, and the review leg retries forever. On a
 *  missing-object failure: fetch branch/PR heads from the source repo's origin into the private
 *  clone, retry `materialize` ONCE, and otherwise return the original failure — which flows to
 *  the existing REVIEW_UNAVAILABLE queue path and is bounded by the #426 aging escalation, so
 *  this adds no new retry state anywhere. */
export async function materializeWithExternalFetch(
  opts: MaterializeOptions & { sourceRepoDir: string; log?: (message: string) => void },
): Promise<MaterializeResult> {
  const first = await materialize(opts);
  if (first.kind !== "failure" || !MISSING_OBJECT_SIGNATURE.test(first.reason)) return first;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const remoteUrl = await sourceOriginUrl(opts.sourceRepoDir, timeoutMs);
  if (remoteUrl == null) return first;
  opts.log?.(`[sapwood:review] head ${opts.oid} is absent from the local object store — fetching external heads from origin (#499)`);
  const { args, env } = buildExternalHeadFetchInvocation(opts.clone.dir, remoteUrl);
  try {
    await pexecFile("git", args, { env, timeout: timeoutMs });
  } catch (err) {
    opts.log?.(`[sapwood:review] external-head fetch failed: ${(err as Error).message} (#499)`);
    return first;
  }
  return materialize(opts);
}
