// claude-version-startup-check.ts (#799, PLAN.md:129): startup VISIBILITY for the installed
// Claude Code CLI's version against the engine's declared floor (worker.ts's own
// MIN_CLAUDE_CLI_VERSION) — not a gate. worker.ts's probeLlmPing argv comment documents the
// consequence of skipping this: an older CLI missing one of the flags that argv depends on fails
// EVERY worker leg and EVERY probe with "error: unknown option ...", which #168's deterministic
// signature classifier reads as an ENVIRONMENT failure, so the engine parks the LLM source and
// backs off with bounded probes — the loop looks like a rate-limit outage instead of naming its
// real, fixable cause (an outdated CLI). This module says the real cause once, up front, in both
// channels the supervision playbook's `events` polling actually watches (log + event stream).
//
// Same placement/never-blocks stance as detectDeployKeyStartupTier/detectManagedPermissionMode/
// detectRapidRestart/detectConsecutiveStalls (cli.ts: run once per engine start, strictly after
// run-started, never gates startup or dispatch — a below-floor CLI may still work in practice;
// the operator may know something this check does not, and a startup detector that can wedge the
// engine is a worse failure than the one it reports).
//
// Reuse, don't re-probe (the issue's own AC3): the binary this module probes is EXACTLY the
// caller's own discoverClaudeBin(process.env) result — never a second discovery implementation.
// The probe itself is `--version` only — a DIFFERENT question from probeLlmPing's "is the
// provider reachable" (the issue's own non-goal: this is not a second usability probe, and it
// costs nothing — no -p, no --model, no --max-budget-usd, see AC6's own test).
//
// The actual `child_process.spawn` call (probeClaudeVersion) lives in worker.ts, NOT here — this
// module only imports its result type and re-exports the function for callers' convenience. See
// worker.ts's own "#799: the version probe" comment for why: worker.test.ts's `#69 grep-invariant`
// enforces that no engine module besides a short named allowlist (worker.ts among them) may
// import node:child_process at all — the "Claude CLI coupling isolated in worker.ts" property
// PLAN.md:129 itself names as a v1 requirement. A second spawn site here would either violate
// that invariant or force widening its allowlist for no architectural reason.
import { type ClaudeVersionProbeResult, MIN_CLAUDE_CLI_VERSION, probeClaudeVersion } from "../roles/worker.js";
import type { State } from "../state/state.js";

export type { ClaudeVersionProbeResult } from "../roles/worker.js";
export { CLAUDE_VERSION_PROBE_TIMEOUT_MS, probeClaudeVersion } from "../roles/worker.js";

/** Which of the three shapes the issue names produced the reported arm. `indeterminate` covers
 *  every failure to read a version at all — spawn error, non-zero exit, unparseable stdout, or a
 *  timeout — and is reported as "could not determine the installed version", never silently
 *  folded into `ok` (a check that must abstain says so) and never reported as `below-floor` (a
 *  check that could not read a version has no evidence the CLI is actually below the floor). */
export type ClaudeVersionStartupArm = "ok" | "below-floor" | "indeterminate";

export interface ClaudeVersionStartupResult {
  arm: ClaudeVersionStartupArm;
  installed?: string;
  floor: string;
}

/** Parses a dotted `major.minor.patch` version out of free-form CLI output — a real
 *  `claude --version` carries trailing text (e.g. "2.1.209 (Claude Code)"), so this reads the
 *  first `\d+\.\d+\.\d+` substring rather than requiring the whole string to match. `undefined`
 *  when no such substring exists (the caller's `indeterminate` case). */
export function parseClaudeVersion(text: string): [number, number, number] | undefined {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Three-way compare of two [major,minor,patch] tuples: negative if `a` < `b`, 0 if equal,
 *  positive if `a` > `b`. Boundary-inclusive callers (AC4: the floor itself is `ok`) compare
 *  `< 0`, never `<= 0`. */
function compareVersion(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

const UPGRADE_COMMAND = "npm i -g @anthropic-ai/claude-code@latest";

const guidance = (installed: string | undefined, floor: string): string =>
  `upgrade with \`${UPGRADE_COMMAND}\` (floor: ${floor}${installed ? `, installed: ${installed}` : ""}); ` +
  "see docs/getting-started.md's Requirements and docs/configuration.md's `worker` section.";

/** Run once per engine start (cli.ts, strictly after `run-started`, same never-gating position
 *  as detectDeployKeyStartupTier — see this module's own header for the full placement
 *  rationale). `claudeBin` is the CALLER's own `discoverClaudeBin(process.env)` result — this
 *  function never resolves the binary itself (AC3: never a second discovery implementation).
 *  Never throws (AC7): a throwing injected probe still resolves `indeterminate` rather than
 *  propagating, so a broken check can never become a new startup-failure mode. Always returns
 *  the detected result, mostly for tests — no dispatch gate reads it (AC6: visibility, not a
 *  gate). */
export async function detectClaudeVersionStartupTier(
  claudeBin: string,
  state: Pick<State, "appendEvent">,
  log: (message: string) => void = (line) => console.error(line),
  opts: { probe?: (bin: string) => Promise<ClaudeVersionProbeResult>; floor?: string } = {},
): Promise<ClaudeVersionStartupResult> {
  const probe = opts.probe ?? probeClaudeVersion;
  const floor = opts.floor ?? MIN_CLAUDE_CLI_VERSION;
  const floorTuple = parseClaudeVersion(floor);
  if (!floorTuple) {
    // Defensive only — MIN_CLAUDE_CLI_VERSION's own shape is pinned by a worker.test.ts
    // assertion, so this branch should be unreachable in production; an injected `opts.floor`
    // in a test is the only realistic way to hit it, and even then this must not throw (AC7).
    log(
      `[sapwood:startup] Claude Code CLI version: could not determine the installed version (configured floor "${floor}" does not parse).`,
    );
    return record(state, { arm: "indeterminate", floor });
  }

  let probeResult: ClaudeVersionProbeResult;
  try {
    probeResult = await probe(claudeBin);
  } catch (e) {
    // AC7: a THROWING probe — never the shipped probeClaudeVersion's own contract, but an
    // injected test double (or a future caller) might — still resolves `indeterminate`, never
    // propagates.
    log(
      `[sapwood:startup] Claude Code CLI version: could not determine the installed version ` +
        `(probe threw: ${e instanceof Error ? e.message : String(e)}) — ${guidance(undefined, floor)}`,
    );
    return record(state, { arm: "indeterminate", floor });
  }

  if (!probeResult.ok) {
    log(
      `[sapwood:startup] Claude Code CLI version: could not determine the installed version ` +
        `(${probeResult.detail}) — ${guidance(undefined, floor)}`,
    );
    return record(state, { arm: "indeterminate", floor });
  }

  const installedTuple = parseClaudeVersion(probeResult.stdout);
  if (!installedTuple) {
    log(
      `[sapwood:startup] Claude Code CLI version: could not determine the installed version ` +
        `(unparseable \`--version\` output: ${JSON.stringify(probeResult.stdout.trim().slice(0, 200))}) — ${guidance(undefined, floor)}`,
    );
    return record(state, { arm: "indeterminate", floor });
  }
  const installed = installedTuple.join(".");

  if (compareVersion(installedTuple, floorTuple) < 0) {
    log(
      `[sapwood:startup] Claude Code CLI version ${installed} is BELOW the engine's declared floor ${floor} — ` +
        `worker legs and the LLM-source probe may fail every call with "error: unknown option ...", which reads ` +
        `as a provider outage rather than an outdated CLI. ${guidance(installed, floor)}`,
    );
    return record(state, { arm: "below-floor", installed, floor });
  }

  log(`[sapwood:startup] Claude Code CLI version: ${installed} (>= floor ${floor}).`);
  return record(state, { arm: "ok", installed, floor });
}

function record(state: Pick<State, "appendEvent">, result: ClaudeVersionStartupResult): ClaudeVersionStartupResult {
  state.appendEvent("claude-cli-version-checked", {
    arm: result.arm,
    floor: result.floor,
    ...(result.installed !== undefined ? { installed: result.installed } : {}),
  });
  return result;
}
