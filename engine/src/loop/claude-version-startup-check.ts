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
// #799 gate② P1 #1 (sol-high): the never-throw/never-gate property was FALSE in the shipped
// round — only the probe call was wrapped; a throwing `appendEvent`/logger propagated past the
// `await` both driver paths sit on (cli.ts), and an injected never-resolving probe hung forever
// (probeClaudeVersion's OWN bound only protects the real production probe, never an injected
// double). Fixed on two independent axes, defense-in-depth:
//   (a) EVERY internal log/record call is wrapped so a throwing collaborator (a broken
//       `appendEvent`, a throwing logger) is swallowed, never propagated — this is a startup
//       VISIBILITY check; its own failure to report is itself just another thing to survive, not
//       to escalate into an aborted dispatch. The whole exported function body ALSO sits behind
//       one outer try/catch as the backstop of last resort.
//   (b) the awaited probe races a DETECTOR-OWN timer (`DETECTOR_TIMEOUT_MS`, reconciled above
//       `CLAUDE_VERSION_PROBE_TIMEOUT_MS` so the real, already-bounded production probe never
//       trips it) — an injected probe that ignores every bound of its own still resolves
//       `indeterminate` on schedule.
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
import {
  CLAUDE_VERSION_PROBE_TIMEOUT_MS,
  type ClaudeVersionProbeResult,
  MIN_CLAUDE_CLI_VERSION,
  probeClaudeVersion,
} from "../roles/worker.js";
import type { State } from "../state/state.js";
import { DOC_LINKS } from "../util/doc-links.js";

export type { ClaudeVersionProbeResult } from "../roles/worker.js";
export { CLAUDE_VERSION_PROBE_TIMEOUT_MS, probeClaudeVersion } from "../roles/worker.js";

/** Which of the three shapes the issue names produced the reported arm. `indeterminate` covers
 *  every failure to read a version at all — spawn error, non-zero exit, unparseable stdout, a
 *  hung probe, or a detector-internal error — and is reported as "could not determine the
 *  installed version", never silently folded into `ok` (a check that must abstain says so) and
 *  never reported as `below-floor` (a check that could not read a version has no evidence the
 *  CLI is actually below the floor). */
export type ClaudeVersionStartupArm = "ok" | "below-floor" | "indeterminate";

export interface ClaudeVersionStartupResult {
  arm: ClaudeVersionStartupArm;
  installed?: string;
  floor: string;
}

/** #799 gate② P1 #1 fix: the detector's OWN timeout, independent of `CLAUDE_VERSION_PROBE_
 *  TIMEOUT_MS` (the production probe's own internal bound). Reconciled ABOVE it — the real
 *  `probeClaudeVersion` always settles within its own bound, so this backstop timer only ever
 *  fires for a probe that does NOT honor any bound of its own (an injected test double, or a
 *  future caller's probe implementation bug). Kept small: a `--version` probe legitimately
 *  taking multiple seconds already indicates trouble, and this is a WARN-only visibility check —
 *  a longer hold here only delays startup for no benefit. */
export const DETECTOR_TIMEOUT_MS = CLAUDE_VERSION_PROBE_TIMEOUT_MS + 2_000;

/** A parsed `claude --version` reading: the exact matched substring (`display`, for the
 *  operator-facing "installed" text — e.g. "2.1.209-beta.1", not just its numeric core), the
 *  numeric `[major,minor,patch]` core, and whether a SemVer-shaped prerelease suffix (`-tag`)
 *  followed it. */
export interface ParsedVersion {
  display: string;
  core: readonly [number, number, number];
  prerelease: boolean;
}

/** #799 gate② P2 #6 fix (sol-high): parses `claude --version`'s OWN documented output shape —
 *  `X.Y.Z (Claude Code)`, optionally `X.Y.Z-prerelease.N (Claude Code)` — anchored at the START
 *  of the (trimmed) text, never a bare "first triple anywhere in the string" scan. The prior,
 *  unanchored regex manufactured two false readings sol-high reproduced against real-shaped
 *  output: `"build 2026.08.12; Claude Code 2.1.100"` parsed as `2026.8.12` (the date, not the
 *  actual `2.1.100` later in the string) — anchoring at the start refuses to parse a version out
 *  of arbitrary PRECEDING prose, so this now correctly falls through to `undefined`
 *  (`indeterminate`) instead of manufacturing a false `ok`. `undefined` when the trimmed text
 *  does not open with a `\d+\.\d+\.\d+` triple — the caller's `indeterminate` case. */
export function parseClaudeVersion(text: string): ParsedVersion | undefined {
  const m = text.trim().match(/^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z][0-9A-Za-z.-]*)?/);
  if (!m) return undefined;
  return { display: m[0], core: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] !== undefined };
}

/** Three-way compare of two parsed versions: negative if `a` < `b`, 0 if equal, positive if
 *  `a` > `b`. Boundary-inclusive callers (AC4: the floor itself is `ok`) compare `< 0`, never
 *  `<= 0`. #799 gate② P2 #6 fix: when the numeric CORE ties, a prerelease sorts BELOW its own
 *  stable release (SemVer precedence, §11) — `2.1.209-beta.1` is BELOW the stable `2.1.209`
 *  floor, not equal to it. The prior parser silently discarded the `-beta.1` suffix and treated
 *  the two as identical, manufacturing a false `ok` (sol-high gate② reproduction). Only matters
 *  when the core ties — a prerelease of a NEWER core (e.g. `2.2.0-beta.1`) still compares ABOVE
 *  an older stable floor (`2.1.209`) on the core comparison alone, correctly. */
function compareVersion(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i++) {
    const d = a.core[i]! - b.core[i]!;
    if (d !== 0) return d;
  }
  if (a.prerelease === b.prerelease) return 0;
  return a.prerelease ? -1 : 1;
}

const UPGRADE_COMMAND = "npm i -g @anthropic-ai/claude-code@latest";

const guidance = (installed: string | undefined, floor: string): string =>
  `upgrade with \`${UPGRADE_COMMAND}\` (floor: ${floor}${installed ? `, installed: ${installed}` : ""}); ` +
  `see ${DOC_LINKS.gettingStarted}'s Requirements and ${DOC_LINKS.configuration}'s \`worker\` section.`;

/** #799 gate② P1 #1 fix (a): a throwing collaborator (`log`, `state.appendEvent`) must never
 *  abort this startup VISIBILITY check — swallowed, best-effort. A failure to REPORT the arm is
 *  itself just one more thing this check survives, not a reason to hold up dispatch. */
function safeLog(log: (message: string) => void, message: string): void {
  try {
    log(message);
  } catch {
    /* best-effort: a broken logger must not abort a startup visibility check (#799 gate② P1 #1) */
  }
}

/** #799 gate② P2 #5 fix (sol-high): the durable event's payload now carries `guidance` for the
 *  `below-floor`/`indeterminate` arms — the SAME upgrade-command text the log line carries — so
 *  `sapwood events` shows the actionable command without requiring a log-file cross-reference
 *  (the issue's own "observable outcome": `sapwood events` names the installed version, the
 *  floor, AND the upgrade command). `ok` carries no `guidance` (nothing actionable to say).
 *  #799 gate② P1 #1 fix (a): wrapped — a throwing `appendEvent` must not propagate. */
function safeRecord(
  state: Pick<State, "appendEvent">,
  result: ClaudeVersionStartupResult,
  guidanceText: string | undefined,
): ClaudeVersionStartupResult {
  try {
    state.appendEvent("claude-cli-version-checked", {
      arm: result.arm,
      floor: result.floor,
      ...(result.installed !== undefined ? { installed: result.installed } : {}),
      ...(guidanceText !== undefined ? { guidance: guidanceText } : {}),
    });
  } catch {
    /* best-effort: a broken durable-event write must not abort a startup visibility check */
  }
  return result;
}

/** #799 gate② P1 #1 fix (b): races the (possibly injected, possibly non-conforming) probe
 *  against `DETECTOR_TIMEOUT_MS`. Never rejects: a synchronously-throwing probe, a probe whose
 *  returned promise rejects, and a probe that never settles at all all resolve `{ok:false,
 *  detail}` instead. */
function raceProbe(probe: (bin: string) => Promise<ClaudeVersionProbeResult>, claudeBin: string): Promise<ClaudeVersionProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: ClaudeVersionProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, detail: `detector-level timeout after ${DETECTOR_TIMEOUT_MS}ms — the version probe did not settle` });
    }, DETECTOR_TIMEOUT_MS);
    // A synchronously-throwing `probe` (not a rejected promise — an actual `throw` before any
    // Promise is even returned) would otherwise escape `.then`'s rejection handler entirely; the
    // `try` below is what catches THAT shape. A probe returning a genuinely rejected promise is
    // caught by `.then`'s second argument, same as always.
    try {
      Promise.resolve(probe(claudeBin)).then(
        (r) => {
          clearTimeout(timer);
          finish(r);
        },
        (e: unknown) => {
          clearTimeout(timer);
          finish({ ok: false, detail: `probe threw: ${e instanceof Error ? e.message : String(e)}` });
        },
      );
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, detail: `probe threw synchronously: ${e instanceof Error ? e.message : String(e)}` });
    }
  });
}

/** Run once per engine start (cli.ts, strictly after `run-started`, same never-gating position
 *  as detectDeployKeyStartupTier — see this module's own header for the full placement
 *  rationale). `claudeBin` is the CALLER's own `discoverClaudeBin(process.env)` result — this
 *  function never resolves the binary itself (AC3: never a second discovery implementation).
 *  Never throws, never hangs past `DETECTOR_TIMEOUT_MS` (AC7 + #799 gate② P1 #1): a throwing or
 *  never-resolving probe, a throwing logger, and a throwing `state.appendEvent` all resolve
 *  `indeterminate` rather than propagating or hanging, so a broken check can never become a new
 *  startup-failure mode. Always returns the detected result, mostly for tests — no dispatch gate
 *  reads it (AC6: visibility, not a gate). */
export async function detectClaudeVersionStartupTier(
  claudeBin: string,
  state: Pick<State, "appendEvent">,
  log: (message: string) => void = (line) => console.error(line),
  opts: { probe?: (bin: string) => Promise<ClaudeVersionProbeResult>; floor?: string } = {},
): Promise<ClaudeVersionStartupResult> {
  const floor = opts.floor ?? MIN_CLAUDE_CLI_VERSION;
  // #799 gate② P1 #1 fix (a): the WHOLE body sits behind one outer try/catch — the backstop of
  // last resort behind safeLog/safeRecord/raceProbe's own individual guards, in case any of
  // those miss a shape (defense in depth, never relied on alone).
  try {
    return await detectInner(claudeBin, state, log, opts, floor);
  } catch (e) {
    safeLog(
      log,
      `[sapwood:startup] Claude Code CLI version: could not determine the installed version (detector error: ${
        e instanceof Error ? e.message : String(e)
      }).`,
    );
    return safeRecord(state, { arm: "indeterminate", floor }, undefined);
  }
}

async function detectInner(
  claudeBin: string,
  state: Pick<State, "appendEvent">,
  log: (message: string) => void,
  opts: { probe?: (bin: string) => Promise<ClaudeVersionProbeResult>; floor?: string },
  floor: string,
): Promise<ClaudeVersionStartupResult> {
  const probe = opts.probe ?? probeClaudeVersion;
  const floorParsed = parseClaudeVersion(floor);
  if (!floorParsed) {
    // Defensive only — MIN_CLAUDE_CLI_VERSION's own shape is pinned by a worker.test.ts
    // assertion, so this branch should be unreachable in production; an injected `opts.floor`
    // in a test is the only realistic way to hit it, and even then this must not throw (AC7).
    safeLog(
      log,
      `[sapwood:startup] Claude Code CLI version: could not determine the installed version (configured floor "${floor}" does not parse).`,
    );
    return safeRecord(state, { arm: "indeterminate", floor }, undefined);
  }

  const probeResult = await raceProbe(probe, claudeBin);

  if (!probeResult.ok) {
    const g = guidance(undefined, floor);
    safeLog(log, `[sapwood:startup] Claude Code CLI version: could not determine the installed version (${probeResult.detail}) — ${g}`);
    return safeRecord(state, { arm: "indeterminate", floor }, g);
  }

  const installedParsed = parseClaudeVersion(probeResult.stdout);
  if (!installedParsed) {
    const g = guidance(undefined, floor);
    safeLog(
      log,
      `[sapwood:startup] Claude Code CLI version: could not determine the installed version (unparseable ` +
        `\`--version\` output: ${JSON.stringify(probeResult.stdout.trim().slice(0, 200))}) — ${g}`,
    );
    return safeRecord(state, { arm: "indeterminate", floor }, g);
  }
  const installed = installedParsed.display;

  if (compareVersion(installedParsed, floorParsed) < 0) {
    const g = guidance(installed, floor);
    safeLog(
      log,
      `[sapwood:startup] Claude Code CLI version ${installed} is BELOW the engine's declared floor ${floor} — ` +
        `worker legs and the LLM-source probe may fail every call with "error: unknown option ...", which reads ` +
        `as a provider outage rather than an outdated CLI. ${g}`,
    );
    return safeRecord(state, { arm: "below-floor", installed, floor }, g);
  }

  safeLog(log, `[sapwood:startup] Claude Code CLI version: ${installed} (>= floor ${floor}).`);
  return safeRecord(state, { arm: "ok", installed, floor }, undefined);
}
