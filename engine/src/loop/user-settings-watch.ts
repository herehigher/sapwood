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
  /** `null` when the file is absent/unreadable — the ordinary, unmanaged-host case. */
  hash: string | null;
  weakening: string[];
}

function readSnapshot(path: string, deps: UserSettingsWatchDeps): UserSettingsSnapshot {
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let raw: string;
  try {
    raw = readFile(path);
  } catch {
    return { hash: null, weakening: [] };
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
  const baseline = readSnapshot(path, deps);
  let lastHash = baseline.hash;
  let lastWeakeningKey = ""; // deliberately blank — see doc above.

  return function checkUserSettingsDrift(): void {
    try {
      const current = readSnapshot(path, deps);
      const changed = current.hash !== lastHash;
      const currentWeakeningKey = weakeningKey(current.weakening);
      const weakeningDrifted = currentWeakeningKey !== lastWeakeningKey;
      if (changed || weakeningDrifted) {
        log(
          `[sapwood:tick] operator user-level settings (${path}) ${changed ? "changed" : "weakening entries changed"} ` +
            `since last observed — a worker leg's Bash(node *)/Bash(npm *) grant loads this file with the operator's ` +
            "REAL $HOME (structurally unconfined, see docs/security.md's HONEST SCOPE note); " +
            (current.weakening.length > 0
              ? `currently present: ${current.weakening.join(", ")}. `
              : "no containment-weakening entries currently present. ") +
            "See docs/security.md's #285 section and #615 for the accepted detect-and-disclose posture.",
        );
        state.appendEvent("user-settings-drift-detected", { settingsPath: path, changed, weakening: current.weakening });
      }
      lastHash = current.hash;
      lastWeakeningKey = currentWeakeningKey;
    } catch (error) {
      // Same best-effort, never-block-the-loop stance as every sibling detector in this
      // neighborhood (checkWebAccessSettingsDenial, detectManagedPermissionMode): a failure HERE
      // (e.g. state.appendEvent throwing on a SQLite write error) must never propagate into the
      // tick loop it's riding along on.
      log(`[sapwood:tick] user-settings drift check failed (non-fatal, tick continues): ${String(error)}`);
    }
  };
}
