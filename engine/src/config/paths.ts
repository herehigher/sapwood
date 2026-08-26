import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The engine's runtime root — the ONE fixed name every runtime artifact (state, sentinels,
// sessions, cache) lives under, so it stays visually and mechanically disjoint from a target
// repo's own `data/` (a name real projects use for real data — the dogfood deployment used to
// commingle engine state with operator scratch under exactly that name). No config key: unlike
// `promptFile`/`logging.path`, the root itself is not operator-tunable — every runtime path in
// this codebase is spelled ONLY here (owner-adjudicated design, precedent: `.git/`, `.beads/`,
// `.pytest_cache/` — a single tool-named root, internally partitioned, self-declaring
// `.gitignore`).
export const SAPWOOD_DIR = ".sapwood";

// Single authority for every bare filename `runtimePaths()` joins onto a root — exported so the
// handful of callers that need the BASENAME alone (state.ts's DEFAULT_DB_PATH/
// INSTANCE_LOCK_FILENAME, cli.ts's SENTINEL_FILENAME, dashboard's ATTENTION_DISMISSALS_FILE)
// derive it from here instead of restating the string a second time. `runtimePaths()` itself is
// built from these same constants below — one spelling, not two.
export const SAPWOOD_DB_FILENAME = "sapwood.sqlite";
export const SAPWOOD_LOCK_FILENAME = "sapwood.lock";
export const SAPWOOD_KILL_SWITCH_FILENAME = "KILL_SWITCH";
export const SAPWOOD_ESTOP_FILENAME = "EMERGENCY_STOP";
export const SAPWOOD_PAUSE_FILENAME = "PAUSE";
export const SAPWOOD_ESCALATION_FILENAME = "ESCALATION";
export const SAPWOOD_ATTENTION_DISMISSALS_FILENAME = "attention-dismissals.jsonl";
// The primary (non-host-suffixed) worker deploy key's basename — the ONE slot every machine's
// first-ever `sapwood init` provisions into; init.ts's own per-host fallback
// (pickFreshArmAKeySlot) derives its sibling names from this same string rather than a second
// literal.
export const DEPLOY_KEY_BASENAME = "worker-deploy-key";

/** The full named layout under a runtime root, computed once so every caller (state.ts,
 *  cli.ts, the role runners, the review materializer/production wiring, skills-plugin.ts,
 *  the dashboard) agrees by construction instead of by repeating a join() convention. Two
 *  classes, per the design: everything directly under `root` is STATE (durable recovery
 *  truth or human-flippable control input); everything under `cacheDir` is CACHE (safe to
 *  delete whenever no engine is running). */
export interface RuntimePaths {
  readonly root: string;
  readonly gitignore: string;

  // ── state: durable recovery truth (06-persistence.md:42) ──
  readonly db: string;
  readonly dbWal: string;
  readonly dbShm: string;
  readonly lock: string;
  readonly sessionsStateDir: string;
  readonly sessionsRolesDir: string;
  readonly sessionsReviewCodexDir: string;
  readonly proxyBundlesDir: string;
  readonly roundsDir: string;
  readonly attentionDismissals: string;

  // ── state: human-flippable control sentinels + engine-authored markers ──
  readonly killSwitch: string;
  readonly estop: string;
  readonly pause: string;
  readonly escalation: string;

  // ── state: operator-steering + generated-config inputs ──
  readonly directiveMd: string;
  readonly directivesDir: string;
  readonly logsDir: string;
  readonly logFile: string;
  /** #1080: the worker deploy key(s) live here — `worker-deploy-key[-<host>]` + `.pub`,
   *  0600/dir 0700 — instead of the pre-#1080 `data/` location. */
  readonly keysDir: string;
  /** The primary key's id sidecar — the local half of the (key, id) anchor `sapwood init`'s
   *  reconcile pass keys on. This ONE fixed name is the canonical slot every machine's
   *  first-ever provisioning writes to; a per-host suffixed sibling (minted only when the
   *  primary anchor fails to reconcile — init.ts's armAuthFailsStaleOrMismatch) is discovered
   *  dynamically instead (findDeployKeyAnchor below), never a second RuntimePaths field, since
   *  its own basename varies by hostname. Same 0600 mode as the key itself; gitignored with the
   *  rest of this root — never a fact in the audited sapwood.config.yaml. */
  readonly deployKeySidecar: string;

  // ── cache: safe to delete whenever no engine runs ──
  readonly cacheDir: string;
  readonly cacheDirTag: string;
  readonly cacheReviewCloneGit: string;
  readonly cacheReviewTreesDir: string;
  readonly cacheGeneratedRoleSkillsDir: string;
}

/** Every named runtime path, relative to `root`. Pure — no filesystem I/O — so any caller can
 *  compute paths against an injected root (tests) without touching disk; `ensureRuntimeRoot`
 *  below is the one function that writes anything. `State` derives `root` as `dirname(dbPath)`
 *  (never SAPWOOD_DIR directly) so an explicit `--db-path` still yields a coherent sibling set
 *  (sentinels/lock/rounds/proxy-bundles beside whatever DB was actually opened) — the same
 *  semantics `killSwitchPath`/`pausePath`/etc. always had, just computed in one place now. */
export function runtimePaths(root: string): RuntimePaths {
  const sessionsDir = join(root, "sessions");
  const cacheDir = join(root, "cache");
  const cacheReviewDir = join(cacheDir, "review");
  return {
    root,
    gitignore: join(root, ".gitignore"),

    db: join(root, SAPWOOD_DB_FILENAME),
    dbWal: join(root, `${SAPWOOD_DB_FILENAME}-wal`),
    dbShm: join(root, `${SAPWOOD_DB_FILENAME}-shm`),
    lock: join(root, SAPWOOD_LOCK_FILENAME),
    sessionsStateDir: join(sessionsDir, "state"),
    sessionsRolesDir: join(sessionsDir, "roles"),
    sessionsReviewCodexDir: join(sessionsDir, "review-codex"),
    proxyBundlesDir: join(root, "proxy-bundles"),
    roundsDir: join(root, "rounds"),
    attentionDismissals: join(root, SAPWOOD_ATTENTION_DISMISSALS_FILENAME),

    killSwitch: join(root, SAPWOOD_KILL_SWITCH_FILENAME),
    estop: join(root, SAPWOOD_ESTOP_FILENAME),
    pause: join(root, SAPWOOD_PAUSE_FILENAME),
    escalation: join(root, SAPWOOD_ESCALATION_FILENAME),

    directiveMd: join(root, "DIRECTIVE.md"),
    directivesDir: join(root, "directives"),
    logsDir: join(root, "logs"),
    logFile: join(root, "logs", "sapwood.log"),
    keysDir: join(root, "keys"),
    deployKeySidecar: keyIdSidecarPath(join(root, "keys", DEPLOY_KEY_BASENAME)),

    cacheDir,
    cacheDirTag: join(cacheDir, "CACHEDIR.TAG"),
    cacheReviewCloneGit: join(cacheReviewDir, "clone.git"),
    cacheReviewTreesDir: join(cacheReviewDir, "trees"),
    cacheGeneratedRoleSkillsDir: join(cacheDir, "generated", "role-skills"),
  };
}

/** The local (path, id) anchor's id half — a sidecar file beside the deploy key itself, same
 *  0600 permission the key file gets. Not itself a fixed `runtimePaths()` field (the key's own
 *  basename varies — the primary slot, or a per-host suffixed sibling minted when the primary
 *  fails to reconcile) — this derives the sidecar name from whatever key path the caller already
 *  has, the same way every `.pub` public-key sibling is named. */
export function keyIdSidecarPath(keyPath: string): string {
  return `${keyPath}.id`;
}

/** #1105 (see docs/security/credential-tiers.md): this machine's own local deploy-key anchor,
 *  discovered from `runtimePaths(root).keysDir` directly — the anchor is filesystem state now (a
 *  gitignored `<key>.id` sidecar beside the key itself), never a fact recorded in the audited
 *  `sapwood.config.yaml`. Every `*.id` file in the directory is a candidate: the fixed primary
 *  slot (`deployKeySidecar` above), or a per-host suffixed sibling init.ts's
 *  armAuthFailsStaleOrMismatch mints when the primary anchor fails to reconcile and an operator
 *  registers an additional key — that arm never deletes the stale sidecar it's replacing (a
 *  WARN-only outcome touches no file), so more than one can coexist. The most recently WRITTEN
 *  one wins: it is the anchor a `sapwood init` run (or an operator by hand) most recently
 *  confirmed. Ceiling: two operators' keys on one shared machine means the newest `sapwood init`
 *  silently wins over the other's. Upgrade trigger: add a per-host selection rule once that
 *  ambiguity is actually observed. Real filesystem I/O (unlike `runtimePaths()` itself) —
 *  returns undefined when the directory has no valid sidecar at all (a fresh machine, or
 *  `sapwood init` never ran), never throws. */
export function findDeployKeyAnchor(root: string): { keyPath: string; keyId: number } | undefined {
  const dir = runtimePaths(root).keysDir;
  if (!existsSync(dir)) return undefined;
  let best: { keyPath: string; keyId: number; mtimeMs: number } | undefined;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".id")) continue;
    const idPath = join(dir, name);
    const keyPath = idPath.slice(0, -".id".length);
    let raw: string;
    try {
      raw = readFileSync(idPath, "utf8").trim();
    } catch {
      continue; // unreadable sidecar — not a candidate, but not fatal to the scan either
    }
    // Plain decimal digits only — a GitHub deploy-key id is always a positive integer, and
    // `Number()` alone would also accept "1e3"/"0x10"/leading-sign forms as valid ids.
    if (!/^\d+$/.test(raw)) continue;
    const keyId = Number(raw);
    if (!Number.isInteger(keyId) || keyId <= 0) continue;
    // A sidecar with no co-located key file (or one that is not a regular file) is not a real
    // anchor — every filesystem call stays inside this try so a stat race or permission error
    // is just a rejected candidate, never an uncaught throw out of a function documented as
    // never throwing.
    let mtimeMs: number;
    try {
      const keyStat = statSync(keyPath);
      if (!keyStat.isFile()) continue;
      mtimeMs = statSync(idPath).mtimeMs;
    } catch {
      continue;
    }
    if (best === undefined || mtimeMs > best.mtimeMs) {
      best = { keyPath, keyId, mtimeMs };
    }
  }
  return best ? { keyPath: best.keyPath, keyId: best.keyId } : undefined;
}

/** `runtimePaths(root)`'s own default root: `<cwd>/.sapwood`. Call sites with a cwd default to
 *  this; `State` instead derives `root` from an (possibly explicit) db path — see runtimePaths'
 *  own doc. */
export function defaultRuntimeRoot(cwd: string = process.cwd()): string {
  return join(cwd, SAPWOOD_DIR);
}

const GITIGNORE_CONTENT = "*\n";

// The standard cache-directory tag (https://bford.info/cachedir/spec.html) — backup/sync tools
// that honor it (rsync --cvs-exclude, some backup software) skip a tagged directory tree
// entirely. The signature line's exact 32 hex chars are the fixed spec value, not a sapwood
// choice.
const CACHEDIR_TAG_CONTENT =
  "Signature: 8a477f597d28d172789f06886806bc55\n" +
  "# This file is a cache directory tag created by sapwood.\n" +
  "# For information about cache directory tags, see https://bford.info/cachedir/spec.html\n";

// An injectable fs seam, same pattern as loop/instance-lock.ts's own LockFsOps — a byte-content
// comparison alone can prove the FINAL state is correct, but not that a no-op call actually
// SKIPPED the write (an implementation that always re-writes identical content leaves the same
// bytes behind, so a content-only test can't tell the two apart). Defaults to the real node:fs
// calls; tests inject a spy instead.
export interface RuntimeRootFsOps {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  mkdir: (path: string) => void;
}

// Exported so tests can wrap the REAL implementation (a positive control proving an injected
// fake actually records real writes) rather than reimplementing it a second time.
export const realRuntimeRootFsOps: RuntimeRootFsOps = {
  exists: existsSync,
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: writeFileSync,
  mkdir: (path) => {
    mkdirSync(path, { recursive: true });
  },
};

/** Write `path` iff it does not already exist; a pre-existing file is compared byte-for-byte —
 *  identical content is left untouched (repeat calls across a long-lived engine process are a
 *  no-op), DIFFERENT content is preserved as-is (never clobbered) and reported through `log`
 *  once per call so an operator-edited `.gitignore` is never silently overwritten. */
function writeIfAbsentOrIdentical(path: string, content: string, log: (message: string) => void, fs: RuntimeRootFsOps): void {
  if (fs.exists(path)) {
    if (fs.readFile(path) !== content) {
      log(`sapwood: ${path} already exists with different content — leaving it as-is.`);
    }
    return;
  }
  fs.writeFile(path, content);
}

/** Create `root` (and its `cache/` subdirectory) and stamp both self-declaring markers a fresh
 *  runtime root needs: `.gitignore` (`*` — the whole tree is engine-owned, never committed) and
 *  `cache/CACHEDIR.TAG` (the standard tag, so backup/sync tooling that honors it skips the
 *  cache tier). Idempotent (safe to call on every engine start, not just the first): an
 *  existing root/markers with matching content are a no-op.
 *
 *  Every write-capable entry point that can be the FIRST thing to touch a fresh root calls this
 *  before its own first write: `State`'s write-mode constructor (dispatch, `sapwood status`'s
 *  bootstrap-if-missing, and the dashboard's own bootstrap all go through it), and cli.ts's
 *  `runSentinelCommand` (the `pause`/`stop`/`estop` activation path — the one mutator that can
 *  create a fresh root with no State ever constructed). cli.ts's `runEngine` is the ONE
 *  exception to "before its own first write": it must acquire the single-instance lock first,
 *  and a refused (non-owning) start must perform ZERO writes against the holder's directory —
 *  not even idempotent marker writes — so `runEngine` does a bare, idempotent `mkdir` of the
 *  lock file's parent directory (required for the lock's own atomic create, a no-op against an
 *  already-existing dir) ahead of the acquire attempt, and calls this function to stamp the root
 *  only AFTER it has actually won the lock. `sapwood init` (#1080) also calls this — first, before
 *  any of its other config/goal/doctrine/issue-template writes elsewhere in the repo — since the
 *  worker deploy key it provisions now lives under this root's `keys/` subdirectory; the ONLY
 *  refusal is `root` already existing as something other than a directory (init.ts checks this
 *  itself before calling in, so the refusal message can name `sapwood init` specifically).
 *
 *  `fs` defaults to the real node:fs calls; tests inject a spy (RuntimeRootFsOps) instead of
 *  monkey-patching node:fs's own exports, since dependency injection (the same LockFsOps pattern
 *  loop/instance-lock.ts already uses) is the seam that reliably intercepts calls across this
 *  repo's ESM/tsx toolchain. */
export function ensureRuntimeRoot(
  root: string,
  log: (message: string) => void = console.error,
  fs: RuntimeRootFsOps = realRuntimeRootFsOps,
): void {
  fs.mkdir(root);
  writeIfAbsentOrIdentical(join(root, ".gitignore"), GITIGNORE_CONTENT, log, fs);
  const cacheDir = join(root, "cache");
  fs.mkdir(cacheDir);
  writeIfAbsentOrIdentical(join(cacheDir, "CACHEDIR.TAG"), CACHEDIR_TAG_CONTENT, log, fs);
}
