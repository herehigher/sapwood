import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  /** #1080 moves the deploy key file here; this leg only reserves the name. */
  readonly keysDir: string;

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

    db: join(root, "sapwood.sqlite"),
    dbWal: join(root, "sapwood.sqlite-wal"),
    dbShm: join(root, "sapwood.sqlite-shm"),
    lock: join(root, "sapwood.lock"),
    sessionsStateDir: join(sessionsDir, "state"),
    sessionsRolesDir: join(sessionsDir, "roles"),
    sessionsReviewCodexDir: join(sessionsDir, "review-codex"),
    proxyBundlesDir: join(root, "proxy-bundles"),
    roundsDir: join(root, "rounds"),
    attentionDismissals: join(root, "attention-dismissals.jsonl"),

    killSwitch: join(root, "KILL_SWITCH"),
    estop: join(root, "EMERGENCY_STOP"),
    pause: join(root, "PAUSE"),
    escalation: join(root, "ESCALATION"),

    directiveMd: join(root, "DIRECTIVE.md"),
    directivesDir: join(root, "directives"),
    logsDir: join(root, "logs"),
    logFile: join(root, "logs", "sapwood.log"),
    keysDir: join(root, "keys"),

    cacheDir,
    cacheDirTag: join(cacheDir, "CACHEDIR.TAG"),
    cacheReviewCloneGit: join(cacheReviewDir, "clone.git"),
    cacheReviewTreesDir: join(cacheReviewDir, "trees"),
    cacheGeneratedRoleSkillsDir: join(cacheDir, "generated", "role-skills"),
  };
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

/** Write `path` iff it does not already exist; a pre-existing file is compared byte-for-byte —
 *  identical content is left untouched (repeat calls across a long-lived engine process are a
 *  no-op), DIFFERENT content is preserved as-is (never clobbered) and reported through `log`
 *  once per call so an operator-edited `.gitignore` is never silently overwritten. */
function writeIfAbsentOrIdentical(path: string, content: string, log: (message: string) => void): void {
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== content) {
      log(`sapwood: ${path} already exists with different content — leaving it as-is.`);
    }
    return;
  }
  writeFileSync(path, content);
}

/** Create `root` (and its `cache/` subdirectory) and stamp both self-declaring markers a fresh
 *  runtime root needs: `.gitignore` (`*` — the whole tree is engine-owned, never committed) and
 *  `cache/CACHEDIR.TAG` (the standard tag, so backup/sync tooling that honors it skips the
 *  cache tier). Idempotent (safe to call on every engine start, not just the first): an
 *  existing root/markers with matching content are a no-op. Called once, from `State`'s
 *  write-mode constructor — the one place every write-capable engine entry point already
 *  passes through before touching the runtime tree; the read-only `status`/`events` path
 *  deliberately never calls this (same "no filesystem mutation" contract it already has). */
export function ensureRuntimeRoot(root: string, log: (message: string) => void = console.error): void {
  mkdirSync(root, { recursive: true });
  writeIfAbsentOrIdentical(join(root, ".gitignore"), GITIGNORE_CONTENT, log);
  const cacheDir = join(root, "cache");
  mkdirSync(cacheDir, { recursive: true });
  writeIfAbsentOrIdentical(join(cacheDir, "CACHEDIR.TAG"), CACHEDIR_TAG_CONTENT, log);
}
