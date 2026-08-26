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
// Doctrine invariants this file is written against (docs/REVIEW-DOCTRINE.md, "Engine lifecycle & safety"):
//  - Same-tick window rule: dispatch-gate reads (isParked) must be evaluated fresh, post-reclaim,
//    inside tick() — see conductor.ts's PARK section. Nothing here caches a decision across ticks.
//  - Crash-rerun set: probe/backoff state is persisted in state.ts (park_state table), not held
//    in memory here — an engine restart mid-park reads the same row back and resumes probing from
//    where it left off (see State.parkState/recordParkProbe).
//  - Disabled-consumer rule: see conductor.ts's PARK section — the LLM probe only runs when a
//    caller actually wired one (deps.probeLlmReachable); the forge probe always has a consumer
//    (forge is a required TickDeps field), so it always runs.

import type { ParkSource } from "../state/state.js";

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
  // above, just a different tier word.
  //
  // #394 gate② round 3 (Codex sol-high BLOCK finding, P2 — retracts this PR's own first cut,
  // which used a bare `hit your \S+ limit` wildcard): a wildcard stem is NOT provider-specific —
  // `extractFailureText` admits raw stderr verbatim, and a failed session's own tooling can
  // legitimately emit an UNRELATED "hit your X limit" line (concretely: "You've hit your storage
  // limit" from a local disk-quota/MCP-server/other-component error with no rejected
  // rate_limit_event anywhere in the transcript) — the engine would classify it `llm` and park
  // against a perfectly healthy provider. This is NOT symmetric with the miss the wildcard
  // replaced: a too-narrow pattern list produces a false NEGATIVE (misses a real quota message —
  // costs money); a too-wide pattern produces a false POSITIVE (halts the engine on an unrelated
  // failure) — worse. Deliberately narrowed back to an ENUMERATED tier alternation instead:
  // `session` (verified verbatim, #374) and `weekly` (verified verbatim, #394's own AC1) are
  // directly observed; `5-hour` is not yet independently captured but is the CLI's OWN named
  // third plan-quota tier (the two verified messages already establish the family), so it is
  // listed alongside them rather than guessed from scratch.
  //
  // THIS TEXT LIST IS THE THIRD, LAST-RESORT LINE OF DEFENSE — not the only one, and not
  // universal cover either (round 3 review corrected an earlier overclaim in this exact comment
  // that it was). classifyEnvFailure checks TWO structured, text-free signals FIRST (see that
  // function's own doc): a rejected `rate_limit_event` and an errored result with
  // `api_error_status:429` — both provider-authoritative, neither guessable-wrong the way a text
  // pattern is. This list only ever matters when BOTH of those are absent. The residual false-
  // negative surface with all three layers combined is genuinely narrow — a quota failure that
  // produces neither a rejected `rate_limit_event`, nor an `api_error_status:429` result, nor a
  // listed tier word — not the earlier "telemetry catches everything" claim, which was false.
  // Deliberately narrow anyway, not an oversight to "fix" back to a wildcard: keeping this list
  // enumerated costs, at worst, an unclassified quota failure that already cleared BOTH
  // structural checks and still uses unlisted wording — narrow and rare; a wildcard here costs a
  // healthy engine parked on any unrelated "hit your X limit" line — broad and common. Widening
  // this back to a wildcard is the wrong trade — do not.
  //
  // WHAT ACTUALLY BOUNDS A MISSED CLASSIFICATION (round 3 correction — the earlier claim that
  // "the empty-spin breaker bounds it" was WRONG on the path that matters most): round.ts's
  // isRoundFullyDegraded (F23) only ever fires on the PERIPHERAL-session path (align/architect/
  // plan_review/harvest/retro), because its own gate requires `workersThisRound === 0` — a
  // dispatched WORKER lane hitting an unclassified quota/network failure makes that count > 0
  // for the round, defeating the breaker entirely for that path. Concretely: on the peripheral
  // path, a missed classification degrades visibly and (with enough consecutive fully-degraded
  // rounds) still trips the empty-spin park — bounded. On the WORKER-lane path (conductor.ts's
  // reclaim FAILED branch), a missed classification is NOT bounded by anything in this file: the
  // lane simply escalates as an ordinary task failure (gated-reentry, then `needs-human` once
  // exhausted) — a human sees it, but nothing here stops the loop from repeating this same miss
  // on the next dispatched issue that hits the same unclassified failure text.
  "hit your (?:session|weekly|5-hour) limit",
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
 * #394 (F22) / gate② round 3 (Codex sol-high BLOCK finding, P2): `structuredSignal` is the
 * PRIMARY signal, checked BEFORE any text pattern — TWO text-free, provider-authoritative
 * conditions, OR'd together by the caller before this call: (1) the Claude CLI's own structured
 * `rate_limit_event` telemetry (`rate_limit_info.status:"rejected"`, worker.ts's
 * hasRejectedRateLimitEvent) and (2) an errored `result` record carrying the transport-level
 * `api_error_status:429` (worker.ts's hasQuotaErrorStatus). BOTH are needed: a real captured
 * transcript (#374's own fixture) shows the CLI does not always emit a `rate_limit_event` line
 * for a genuine quota failure — signal (1) alone missed that case, which is exactly why gate②
 * round 3 added (2). Unlike the pattern lists below (necessarily a finite, sometimes-stale guess
 * at the CLI's human-readable wording — exactly what missed the real "weekly limit" text this
 * issue fixes), neither structured condition can be produced by anything other than the provider
 * itself refusing the request. Defaults to `false` so every pre-#394 call site (omitting the
 * argument) keeps byte-identical behavior — text-pattern classification only, unchanged.
 *
 * What this does NOT catch (the honest residual gap, not "nothing" — see
 * DEFAULT_LLM_FAILURE_PATTERNS's own comment below for the full accounting): a quota/rate-limit
 * failure that produces neither a rejected `rate_limit_event`, nor an errored result with
 * `api_error_status:429`, nor text matching one of the enumerated tier words below.
 */
export function classifyEnvFailure(output: string, patterns: EnvFailurePatterns, structuredSignal = false): EnvFailureSource | null {
  if (structuredSignal) return "llm";
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
export function escalationChannel(source: ParkSource, forgeParked = false): EscalationChannel {
  // #431: `rapid-restart` (state.ts's ParkSource, the crash-loop detector's episode) rides the
  // non-forge branch — an intact forge is still the preferred channel. In practice its episodes
  // carry no trigger issue, so escalatePark's own triggerIssue branch routes them local anyway.
  // #407: `consecutive-stalls` (the stall breaker's episode) is the identical shape — no
  // trigger issue, escalates locally at trip time — and rides the same branch.
  return source === "forge" || forgeParked ? "local" : "forge";
}
