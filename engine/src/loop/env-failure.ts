// Environment-failure detection + park/probe/backoff/escalation (#168).
//
// Decision 1 (issue #168): an environment failure — the LLM provider (429s / usage-limit /
// credit-exhausted) or the forge (GitHub outage / network partition / gh auth expiry) — is ONE
// class regardless of which upstream broke: never escalate the issue, never spend a gated-
// reentry attempt, park the engine instead. Signature SETS differ per source; the disposition
// (park) is shared.
//
// Decision 2: everything in this file is deterministic engine code. No LLM judgment anywhere —
// classification is a regex match over text the engine already captured, backoff/duration are
// arithmetic, channel selection is a pure function of the classified source. Exhaustively
// testable, no token spend to decide whether tokens exist.
//
// Doctrine invariants this file is written against (engine/prompts/doctrine-template.md):
//  - Same-tick window rule: dispatch-gate reads (isParked) must be evaluated fresh, post-reclaim,
//    inside tick() — see conductor.ts's PARK section. Nothing here caches a decision across ticks.
//  - Crash-rerun set: probe/backoff state is persisted in state.ts (park_state table), not held
//    in memory here — an engine restart mid-park reads the same row back and resumes probing from
//    where it left off (see State.parkState/recordParkProbe).
//  - Disabled-consumer rule: see conductor.ts's PARK section — the LLM probe only runs when a
//    caller actually wired one (deps.probeLlmReachable); the forge probe always has a consumer
//    (forge is a required TickDeps field), so it always runs.

export type EnvFailureSource = "llm" | "forge";

export interface EnvFailurePatterns {
  llm: string[];
  forge: string[];
}

// Deliberately signature-shaped (API/CLI error identifiers), not natural-language phrases like
// bare "rate limit" — a worker's failure text can legitimately DISCUSS rate limits ("add retry
// logic for rate limiting") without ever actually hitting one; matching that would misclassify an
// ordinary task failure as an environment failure. Each pattern below is something only an actual
// 429/quota/network/auth error would contain verbatim.
export const DEFAULT_LLM_FAILURE_PATTERNS: readonly string[] = [
  "rate_limit_error",
  "rate limit exceeded",
  "usage limit reached",
  "credit balance is too low",
  "insufficient_quota",
  "overloaded_error",
  // Compound, not bare "429" — a worker legitimately testing/mocking a third-party 429 response
  // ("expected mock to return 429, got 500") must not match; the full phrase is specific to an
  // actual HTTP client error, never something ordinary task code/prose would contain verbatim.
  "429 too many requests",
  // #374 (2026-07-24 dogfood F16/F17): the Claude CLI's own session/plan-quota exhaustion
  // message, verified verbatim against a real captured session transcript (a `type:"result"`
  // record with `is_error:true`, `api_error_status:429`): "You've hit your session limit ·
  // resets 6:30pm (Asia/Tokyo)". "hit your session limit" is the distinctive, CLI-authored
  // phrase (never something ordinary worker prose would produce verbatim, same signature-shaped
  // bar as "usage limit reached" above) — extractFailureText (worker.ts) already carries this
  // text through for a FAILED lane's `result` field regardless of the record's (misleadingly
  // "success") subtype, since `is_error` alone gates inclusion.
  //
  // #394 (F22 dogfood retro, 2026-07-27): #374's own "5-hour limit"/"weekly limit" guesses above
  // were modeled on a DIFFERENT UI string ("5-hour limit reached" / "weekly limit reached") that
  // never matched the real CLI output and missed a live weekly-quota storm for ~72 rounds (~$80).
  // The real captured text, verbatim: "You've hit your weekly limit · resets Jul 27 at 9am
  // (Asia/Tokyo)" — same "hit your <tier> limit" STEM as the verified session-limit message
  // above, just a different tier word. Rather than guess each remaining tier's exact wording
  // again, match the shared stem directly (regex, matchesAny's `new RegExp(p, "i")`) — this
  // single pattern covers "session"/"weekly"/"5-hour" (all three now verified or directly
  // implied by the verified pair) and any future tier the CLI introduces, without another guess.
  "hit your \\S+ limit",
];

export const DEFAULT_FORGE_FAILURE_PATTERNS: readonly string[] = [
  "could not resolve host",
  "connection refused",
  "network is unreachable",
  "temporary failure in name resolution",
  "bad gateway",
  "gateway timeout",
  "service unavailable",
  "bad credentials",
  "401 unauthorized",
  "gh auth login",
  "SAML enforcement", // gh's org-SSO token-expiry message
];

function matchesAny(text: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    try {
      return new RegExp(p, "i").test(text);
    } catch {
      // A malformed user-supplied pattern degrades to a literal substring match rather than
      // throwing mid-classification (classification must never crash a reclaim tick).
      return text.toLowerCase().includes(p.toLowerCase());
    }
  });
}

/**
 * Classify a FAILED lane's captured failure output against the configured signature pattern
 * sets. Pure, deterministic, no LLM. `llm` is checked before `forge` (fixed precedence — a
 * failure text matching both patterns, unlikely in practice, classifies as `llm`). No match on
 * either set -> null, an ordinary task failure (unchanged existing disposition).
 *
 * #394 (F22): `rateLimitRejected` is the PRIMARY signal, checked BEFORE any text pattern — the
 * Claude CLI's own structured `rate_limit_event` telemetry (`rate_limit_info.status:"rejected"`
 * in the session jsonl, worker.ts's hasRejectedRateLimitEvent) is text-free and authoritative:
 * unlike the pattern lists below (necessarily a finite, sometimes-stale guess at the CLI's
 * human-readable wording — exactly what missed the real "weekly limit" text this issue fixes),
 * a rejected rate-limit event can never be produced by anything other than the provider itself
 * refusing the request. Defaults to `false` so every pre-#394 call site (omitting the argument)
 * keeps byte-identical behavior — text-pattern classification only, unchanged.
 */
export function classifyEnvFailure(output: string, patterns: EnvFailurePatterns, rateLimitRejected = false): EnvFailureSource | null {
  if (rateLimitRejected) return "llm";
  if (!output) return null;
  if (matchesAny(output, patterns.llm)) return "llm";
  if (matchesAny(output, patterns.forge)) return "forge";
  return null;
}

/** Bounded exponential backoff: base * 2^attempts, capped at max. attempts is the number of
 *  CONSECUTIVE failed probes so far (0 for "never probed yet" -> base). Never negative/NaN for
 *  a sane base/max/attempts input. */
export function probeBackoffSec(attempts: number, baseSec: number, maxSec: number): number {
  const raw = baseSec * 2 ** Math.max(0, attempts);
  return Math.min(raw, maxSec);
}

/** Is a probe due? true if never probed (lastProbeAtIso null) or the backoff interval has
 *  elapsed since the last probe. Float-safe ">=" (a probe exactly on the boundary is due —
 *  unlike the budgetExceeded/drainEscalationDue ">" convention elsewhere, an "is it time yet"
 *  check should fire AT the deadline, not strictly after it). */
export function probeDue(lastProbeAtIso: string | null, nowMs: number, backoffSec: number): boolean {
  if (lastProbeAtIso == null) return true;
  return (nowMs - Date.parse(lastProbeAtIso)) / 1000 >= backoffSec;
}

/** Has the park DURATION (not probe count — backoff makes counts ambiguous, issue #168 decision
 *  3) exceeded the configured escalation threshold? Same ">" convention as
 *  budgetExceeded/drainEscalationDue elsewhere in conductor.ts — exactly-at-threshold is not yet
 *  due. */
export function parkDurationExceededSec(enteredAtIso: string, nowMs: number, thresholdSec: number): boolean {
  return (nowMs - Date.parse(enteredAtIso)) / 1000 > thresholdSec;
}

/** #374: same "is a probe due" question as probeDue, but additionally honoring a KNOWN reset
 *  instant — a 429 payload that names exactly when quota comes back (worker.ts's
 *  extractRateLimitResetAt, the Claude CLI's structured `rate_limit_event.resetsAt`) is strictly
 *  better scheduling information than the bounded exponential backoff, which knows nothing about
 *  the real outage length and would otherwise burn several doomed-to-fail probes before backing
 *  off far enough to matter. `resetHintAtIso == null` (no hint was ever observed) reduces this
 *  to plain `probeDue` exactly — byte-identical to every pre-#374 call site. A malformed hint
 *  (unparseable ISO string) is treated the same as "no hint" (fail toward the existing, already-
 *  correct backoff schedule, never toward "never probe again"). Once `nowMs` reaches the hint,
 *  this defers to the ordinary backoff schedule from then on (a hint is a floor on the first
 *  useful probe time, not a promise the very next probe succeeds — the CLI's own reset estimate
 *  can be off by the same clock-skew/timezone slop any third-party timestamp carries). */
export function probeDueWithHint(lastProbeAtIso: string | null, nowMs: number, backoffSec: number, resetHintAtIso: string | null): boolean {
  if (resetHintAtIso != null) {
    const hintMs = Date.parse(resetHintAtIso);
    if (!Number.isNaN(hintMs) && nowMs < hintMs) return false;
  }
  return probeDue(lastProbeAtIso, nowMs, backoffSec);
}

/** #374 (F16): the empty-spin breaker — independent of error CLASSIFICATION (classifyEnvFailure
 *  above may simply not recognize an unfamiliar systemic failure's text), this bounds round
 *  churn on a purely STRUCTURAL signal: how many CONSECUTIVE rounds in a row did no dispatched
 *  work survive AND every peripheral role session that ran this round degraded. `threshold` is
 *  the configured `cfg.round.emptySpin.consecutiveDegradedRoundsThreshold` (user-tunable, small
 *  default) — round.ts's own loop maintains `consecutiveDegradedRounds`, this is just the pure
 *  ">=" comparison, kept here (not inlined) for the same "arithmetic lives beside the other
 *  park-decision arithmetic, independently testable" reasoning every other function in this file
 *  follows. */
export function emptySpinBreached(consecutiveDegradedRounds: number, threshold: number): boolean {
  return consecutiveDegradedRounds >= threshold;
}

export type EscalationChannel = "forge" | "local";

/**
 * The escalation channel ladder (issue #168 decision 4), as a pure function of the classified
 * SOURCE plus whether a forge park episode is currently open — rather than a live re-probe at
 * escalation time: if the forge itself is a failed source, it is — by construction — still
 * unreachable at escalation time (escalation only fires while its episode is still open;
 * parked-for-forge only clears once a forge probe SUCCEEDS, which resumes before escalation
 * could fire). Deterministic, zero-cost, and avoids a second forge round-trip at exactly the
 * moment the forge is suspected down. An `llm`-sourced escalation uses the forge channel — an
 * LLM outage says nothing about forge reachability — UNLESS a forge episode is ALSO open (a
 * mixed storm, PR #180 review): then the forge is known-broken and the llm escalation degrades
 * to the local channel too, never attempting a doomed GitHub write.
 */
export function escalationChannel(source: EnvFailureSource, forgeParked = false): EscalationChannel {
  return source === "forge" || forgeParked ? "local" : "forge";
}
