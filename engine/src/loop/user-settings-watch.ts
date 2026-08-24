// user-settings-watch.ts (#615): the owner-ruled arm (2) response to the worker-leg user-settings
// persistence vector #600 declined to cover — see this issue's recorded ruling and
// docs/security.md's #285 section / HONEST SCOPE note for the full rationale.
//
// Every engine-spawned WORKER leg loads every file-based settings source (worker.ts's
// `claudeArgs` never sets `--setting-sources`, unlike review sessions, which #285 closes with
// `--setting-sources ""`), including the operator's own `~/.claude/settings.json`. A worker leg's
// `Bash(node *)`/`Bash(npm *)` grant runs with the operator's REAL `$HOME` and "structurally
// cannot be filesystem-confined from it" (security.md's `workerCredentialFreeEnv` HONEST SCOPE
// note) — so a producer leg in round N could in principle write that file, and every LATER worker
// leg, any lane, any round, inherits whatever that write left behind.
//
// Ruling (2026-08-04, arm 2 ships): pinning `--setting-sources ""` for worker legs is ruled OUT
// (the #410/#236 collision — that flag also stops the repo's own CLAUDE.md loading). This closes
// nothing structurally; it makes the vector OBSERVABLE, same paradigm as
// `checkWebAccessSettingsDenial` (#410) and `detectManagedPermissionMode` (#554): snapshot once at
// startup, then flag a later divergence. Detection only — never blocks, never mutates, never
// throws out.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { State } from "../state/state.js";
import { DOC_LINKS } from "../util/doc-links.js";

/** Same injected-seam convention as `checkWebAccessSettingsDenial` (cli.ts) — inject the
 *  collaborator, not the CLI. Omitted -> the real `node:fs`/`node:os` calls. */
export interface UserSettingsWatchDeps {
  homedir?: () => string;
  /** Reads the file at `path` and returns its text, or THROWS (missing/unreadable) — same
   *  contract as `readFileSync(path, "utf8")`, which is the real default. */
  readFile?: (path: string) => string;
}

/** Top-level user-settings keys whose mere presence weakens worker containment (the issue's own
 *  "Why" section names these two as the concrete residue a producer-influenced write could
 *  leave): an `apiKeyHelper` is an arbitrary command a worker leg's credential lookups would run,
 *  and `hooks` is arbitrary code execution on tool-use lifecycle events — both bypass the
 *  guard hook entirely (it mediates PreToolUse only, not settings-declared hooks or credential
 *  helpers). Deliberately NOT `permissions.allow` in general: an allow list is normal, legitimate
 *  operator configuration on most hosts, and judging any given rule "weakening" without the
 *  worker's own tool profile in hand would be guesswork the two named keys don't need.
 *  ponytail: two keys, not a general containment-policy evaluator — narrower detectors named the
 *  problem precisely; extend the list only when a NEW concrete residue class is named. */
const CONTAINMENT_WEAKENING_KEYS = ["apiKeyHelper", "hooks"] as const;

function resolveSettingsPath(deps: UserSettingsWatchDeps): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join((deps.homedir ?? homedir)(), ".claude");
  return join(configDir, "settings.json");
}

function weakeningEntries(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const obj = parsed as Record<string, unknown>;
  return CONTAINMENT_WEAKENING_KEYS.filter((key) => obj[key] !== undefined);
}

interface UserSettingsSnapshot {
  /** `null` when the file is ABSENT (ENOENT) — the ordinary, unmanaged-host case, silent by
   *  design. Absent is NOT the same as unreadable: an unreadable file (EACCES, EIO, …) gets the
   *  `UNREADABLE_HASH` sentinel instead, because a detector that cannot read its subject is
   *  BLIND, and blindness must be disclosed once rather than conflated with "nothing to watch"
   *  (PR #632 review, P2: a startup EACCES previously produced no disclosure at all, and one
   *  read failure silenced every later tick via `null === null`). */
  hash: string | null;
  weakening: string[];
  /** Set only on the unreadable arm — carried into the WARN so the disclosure names the actual
   *  error instead of a generic claim. */
  unreadableReason?: string;
}

/** Sentinel hash for the unreadable state. Distinct from every real sha256 hex digest and from
 *  the absent-file `null`, so unreadable→readable and readable→unreadable transitions both fire
 *  the ordinary hash-changed arm, and steady-state unreadable stays silent after its one
 *  disclosure. */
const UNREADABLE_HASH = "__unreadable__";

function readSnapshot(path: string, deps: UserSettingsWatchDeps): UserSettingsSnapshot {
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { hash: null, weakening: [] };
    return { hash: UNREADABLE_HASH, weakening: [], unreadableReason: String(error) };
  }
  let weakening: string[] = [];
  try {
    weakening = weakeningEntries(JSON.parse(raw));
  } catch {
    // Malformed JSON: still hashed/tracked for drift below, no weakening claim from
    // unparsable text (the "authoritative signals" doctrine — don't infer structure that
    // isn't there).
  }
  return { hash: createHash("sha256").update(raw).digest("hex"), weakening };
}

const weakeningKey = (weakening: readonly string[]): string => [...weakening].sort().join(",");

/** Construct once, AT ENGINE STARTUP — this is the "snapshotted/hashed once" moment the
 *  acceptance criteria describe. The returned `check()` closure is the per-tick call: invoke it
 *  once per tick (both drivers already have an `onTick` hook that fires every tick — this rides
 *  that, no new plumbing) to compare the CURRENT file against what was last observed.
 *
 *  Fires (one WARN log line + one durable `user-settings-drift-detected` event) when either:
 *   - the file's content hash differs from what was last observed (a real edit, by anyone), or
 *   - the set of containment-weakening keys present differs from what was last observed —
 *     seeded as *empty* here regardless of the startup snapshot's own content, so a file that
 *     ALREADY carries `apiKeyHelper`/`hooks` at construction time still fires once, on the first
 *     check, rather than being silently grandfathered in.
 *
 *  Silent, by design, when a later check sees the exact same (hash, weakening-set) pair as the
 *  last one — the reverse case the acceptance criteria call out explicitly, and the ordinary
 *  steady-state tick on an unmanaged or unchanged host. */
export function createUserSettingsWatch(
  state: Pick<State, "appendEvent">,
  log: (message: string) => void = console.error,
  deps: UserSettingsWatchDeps = {},
): () => void {
  const path = resolveSettingsPath(deps);
  // Seeds are chosen so the construction-time check below fires exactly when there is something
  // to disclose AT STARTUP and stays silent otherwise: a clean/absent file compares equal to its
  // own baseline; pre-existing weakening keys differ from the blank weakening seed; an
  // unreadable-at-startup file differs from the null hash seed (PR #632 review, P1: the first
  // check used to ride the first onTick, which both drivers fire only AFTER `tick()` — so the
  // first tick's worker dispatch happened before any disclosure landed).
  let lastHash: string | null = null;
  let lastWeakeningKey = ""; // deliberately blank — see doc above.
  {
    const baseline = readSnapshot(path, deps);
    // An absent or clean readable file is the silent startup baseline; anything else (weakening
    // keys present, or unreadable) is left DIFFERENT from the seeds so the construction check
    // fires once.
    if (baseline.hash !== UNREADABLE_HASH && baseline.weakening.length === 0) {
      lastHash = baseline.hash;
    }
  }

  let startupCheck = true; // true only for the construction-time call below — labels its
  // disclosure "at startup" instead of falsely claiming a change was observed.

  function checkUserSettingsDrift(): void {
    try {
      const current = readSnapshot(path, deps);
      const changed = current.hash !== lastHash;
      const currentWeakeningKey = weakeningKey(current.weakening);
      const weakeningDrifted = currentWeakeningKey !== lastWeakeningKey;
      if (changed || weakeningDrifted) {
        const unreadable = current.hash === UNREADABLE_HASH;
        // #554 pattern: every disclosure carries its own fix, in the line itself.
        const fix = unreadable
          ? `Fix: make ${path} readable to the engine's own user (chmod/chown) — drift detection is BLIND until then and will resume on its own once the file reads again.`
          : `Fix: open ${path} and remove any apiKeyHelper/hooks entry you did not put there yourself (or restore the file from a known-good copy); if the change is yours and intentional, no action is needed — this posture is detect-and-disclose, nothing is blocked.`;
        log(
          `[sapwood:tick] operator user-level settings (${path}) ${
            unreadable
              ? `are UNREADABLE (${current.unreadableReason ?? "unknown error"}) — weakening state UNKNOWN, detector degraded${startupCheck ? " from startup" : ""}`
              : startupCheck
                ? "carry containment-weakening entries at startup"
                : changed
                  ? "changed since last observed"
                  : "weakening entries changed since last observed"
          } ` +
            `— a worker leg's Bash(node *)/Bash(npm *) grant loads this file with the operator's ` +
            `REAL $HOME (structurally unconfined, see ${DOC_LINKS.security}'s HONEST SCOPE note); ` +
            (unreadable
              ? ""
              : current.weakening.length > 0
                ? `currently present: ${current.weakening.join(", ")}. `
                : "no containment-weakening entries currently present. ") +
            fix,
        );
        state.appendEvent("user-settings-drift-detected", {
          settingsPath: path,
          changed,
          weakening: current.weakening,
          ...(unreadable ? { unreadable: true } : {}),
        });
      }
      lastHash = current.hash;
      lastWeakeningKey = currentWeakeningKey;
      startupCheck = false;
    } catch (error) {
      // Same best-effort, never-block-the-loop stance as every sibling detector in this
      // neighborhood (checkWebAccessSettingsDenial, detectManagedPermissionMode): a failure HERE
      // (e.g. state.appendEvent throwing on a SQLite write error) must never propagate into the
      // tick loop it's riding along on.
      log(`[sapwood:tick] user-settings drift check failed (non-fatal, tick continues): ${String(error)}`);
    }
  }

  // The STARTUP disclosure itself (PR #632 review, P1): run one check at construction, which is
  // the engine-startup moment (both CLI modes construct this before their loop starts). With the
  // seeds above, a clean or absent file discloses nothing here; pre-existing weakening keys or an
  // unreadable file disclose BEFORE the first tick can dispatch a worker, not one onTick after.
  checkUserSettingsDrift();

  return checkUserSettingsDrift;
}
