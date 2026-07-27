import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyEnvFailure,
  DEFAULT_FORGE_FAILURE_PATTERNS,
  DEFAULT_LLM_FAILURE_PATTERNS,
  emptySpinBreached,
  escalationChannel,
  parkDurationExceededSec,
  probeBackoffSec,
  probeDue,
  probeDueWithHint,
} from "./env-failure.js";

const patterns = { llm: [...DEFAULT_LLM_FAILURE_PATTERNS], forge: [...DEFAULT_FORGE_FAILURE_PATTERNS] };

// ── classifyEnvFailure: positive signature matchers per source ─────────────────────────────

test("classifyEnvFailure: LLM 429 / usage-limit / credit-exhausted signatures -> llm", () => {
  assert.equal(classifyEnvFailure("Error: 429 Too Many Requests", patterns), "llm");
  assert.equal(classifyEnvFailure('{"type":"error","error":{"type":"rate_limit_error"}}', patterns), "llm");
  assert.equal(classifyEnvFailure("usage limit reached for this billing period", patterns), "llm");
  assert.equal(classifyEnvFailure("Your credit balance is too low to access the API", patterns), "llm");
  assert.equal(classifyEnvFailure("insufficient_quota: exceeded current quota", patterns), "llm");
  assert.equal(classifyEnvFailure("the API returned an overloaded_error", patterns), "llm");
});

test("classifyEnvFailure: forge network / 5xx / auth variants -> forge", () => {
  assert.equal(classifyEnvFailure("ssh: Could not resolve host: github.com", patterns), "forge");
  assert.equal(classifyEnvFailure("curl: (7) Failed to connect: Connection refused", patterns), "forge");
  assert.equal(classifyEnvFailure("gh: Bad Gateway (HTTP 502)", patterns), "forge");
  assert.equal(classifyEnvFailure("gh: Service Unavailable (HTTP 503)", patterns), "forge");
  assert.equal(classifyEnvFailure("gh: Bad credentials", patterns), "forge");
  assert.equal(classifyEnvFailure("HTTP 401 Unauthorized", patterns), "forge");
  assert.equal(classifyEnvFailure("gh auth login required to continue", patterns), "forge");
  assert.equal(classifyEnvFailure("Temporary failure in name resolution", patterns), "forge");
});

// ── negative: a worker legitimately failing while DISCUSSING rate limits/networking stays a
//    task failure (issue #168 Verification section, explicit negative case) ──────────────────

test("classifyEnvFailure: ordinary task failure that merely discusses rate limits -> null (not env-failure)", () => {
  const text =
    "FAIL tests/retry.test.ts\n" +
    "  ✗ should add rate limiting to the API client\n" +
    "    Expected retryClient to back off after repeated calls, but no rate limiting was implemented.\n" +
    "    TODO: add a token-bucket rate limiter and handle usage limits gracefully in production.\n" +
    "AssertionError: expected 3 calls to have been throttled";
  assert.equal(classifyEnvFailure(text, patterns), null);
});

test("classifyEnvFailure: ordinary task failure that discusses networking/credentials in prose stays null", () => {
  const text =
    "TypeError: cannot read property 'token' of undefined at auth.ts:42\n" +
    "  near the credential-refresh helper — needs a null check before the network call.\n" +
    "  Consider handling flaky upstream responses and stale sessions in the mock server fixture.";
  assert.equal(classifyEnvFailure(text, patterns), null);
});

test("classifyEnvFailure: empty/missing output -> null", () => {
  assert.equal(classifyEnvFailure("", patterns), null);
});

// ── #374: the real Claude CLI session/plan-quota exhaustion text (dogfood F16/F17) ─────────

test("classifyEnvFailure: Claude CLI session-limit exhaustion (verbatim captured text) -> llm", () => {
  assert.equal(classifyEnvFailure("You've hit your session limit · resets 6:30pm (Asia/Tokyo)", patterns), "llm");
  assert.equal(classifyEnvFailure("[success] You've hit your session limit · resets 6:30pm (Asia/Tokyo)", patterns), "llm");
});

test("classifyEnvFailure: 5-hour/weekly Claude plan-quota tiers use the SAME 'hit your <tier> limit' stem as session-limit, not the old guessed 'X limit reached' shape", () => {
  assert.equal(classifyEnvFailure("You've hit your 5-hour limit · resets 3pm", patterns), "llm");
  assert.equal(classifyEnvFailure("You've hit your weekly limit · resets Monday", patterns), "llm");
});

// ── #394 (F22, dogfood retro 2026-07-27): the REAL captured weekly-limit text — #374's guessed
//    "weekly limit reached" pattern never matched this and missed a live quota storm for ~72
//    rounds (~$80). AC1: this exact verbatim string classifies as llm. ─────────────────────────

test("classifyEnvFailure: AC1 — verbatim captured weekly-limit text classifies as llm", () => {
  assert.equal(classifyEnvFailure("You've hit your weekly limit · resets Jul 27 at 9am (Asia/Tokyo)", patterns), "llm");
});

// ── #394 gate② round 3 (Codex sol-high BLOCK finding, P2): the tier list is a DELIBERATE
//    enumeration (session/weekly/5-hour), not a `\S+` wildcard — an unrelated "hit your <X>
//    limit" line from some OTHER component (storage, disk quota, an MCP server, ...) must NOT
//    false-park the engine absent the structured rate_limit_event signal. ──────────────────────

test("classifyEnvFailure: an UNRELATED 'hit your <X> limit' line (e.g. a storage-quota error from some other component) does NOT classify as llm absent the structured signal — the tier list is enumerated, not a wildcard", () => {
  assert.equal(classifyEnvFailure("You've hit your storage limit", patterns), null);
  assert.equal(classifyEnvFailure("Error: you've hit your disk limit — free up space and retry", patterns), null);
  // The SAME unrelated text, but WITH a genuine rejected rate_limit_event elsewhere in the
  // transcript, still correctly classifies as llm — via the structured signal, never the text.
  assert.equal(classifyEnvFailure("You've hit your storage limit", patterns, true), "llm");
});

// ── #394 (F22): the structured rate_limit_event signal — text-free, authoritative, checked
//    BEFORE any pattern match. AC2: a rejected rate_limit_event classifies as llm even when the
//    human-readable text is unrecognized. ───────────────────────────────────────────────────────

test("classifyEnvFailure: AC2 — rateLimitRejected=true classifies as llm even when the text is completely unrecognized", () => {
  assert.equal(classifyEnvFailure("some brand new CLI wording nobody has ever seen before", patterns, true), "llm");
  assert.equal(classifyEnvFailure("", patterns, true), "llm", "even empty output — the structured signal alone is authoritative");
});

test("classifyEnvFailure: rateLimitRejected omitted/false -> unchanged text-pattern-only behavior (backward compatible)", () => {
  assert.equal(classifyEnvFailure("ordinary task failure, nothing env-related", patterns), null);
  assert.equal(classifyEnvFailure("ordinary task failure, nothing env-related", patterns, false), null);
});

test("classifyEnvFailure: llm precedence over forge when both signatures somehow appear", () => {
  const text = "429 Too Many Requests while also seeing Bad Gateway upstream";
  assert.equal(classifyEnvFailure(text, patterns), "llm");
});

test("classifyEnvFailure: a malformed user-supplied pattern degrades to literal substring match, never throws", () => {
  const bad = { llm: ["([unterminated"], forge: [] };
  assert.doesNotThrow(() => classifyEnvFailure("text with ([unterminated inside", bad));
  assert.equal(classifyEnvFailure("text with ([unterminated inside", bad), "llm");
  assert.equal(classifyEnvFailure("no match here", bad), null);
});

// ── probeBackoffSec: bounded exponential backoff ────────────────────────────────────────────

test("probeBackoffSec: doubles per attempt, capped at max", () => {
  assert.equal(probeBackoffSec(0, 30, 1800), 30);
  assert.equal(probeBackoffSec(1, 30, 1800), 60);
  assert.equal(probeBackoffSec(2, 30, 1800), 120);
  assert.equal(probeBackoffSec(3, 30, 1800), 240);
  assert.equal(probeBackoffSec(10, 30, 1800), 1800); // capped, not 30*1024
});

test("probeBackoffSec: negative attempts clamp to 0 (never below base)", () => {
  assert.equal(probeBackoffSec(-5, 30, 1800), 30);
});

// ── probeDue ─────────────────────────────────────────────────────────────────────────────────

test("probeDue: never probed yet -> always due", () => {
  assert.equal(probeDue(null, Date.parse("2026-07-14T00:00:00Z"), 60), true);
});

test("probeDue: due exactly at the boundary and after; not due before it", () => {
  const last = "2026-07-14T00:00:00Z";
  const lastMs = Date.parse(last);
  assert.equal(probeDue(last, lastMs + 59_000, 60), false);
  assert.equal(probeDue(last, lastMs + 60_000, 60), true); // exactly at boundary -> due
  assert.equal(probeDue(last, lastMs + 61_000, 60), true);
});

// ── parkDurationExceededSec: duration-based escalation trigger, NOT probe-count-based ─────────

test("parkDurationExceededSec: exactly-at-threshold is not yet exceeded; past it is", () => {
  const entered = "2026-07-14T00:00:00Z";
  const enteredMs = Date.parse(entered);
  assert.equal(parkDurationExceededSec(entered, enteredMs + 3600_000, 3600), false);
  assert.equal(parkDurationExceededSec(entered, enteredMs + 3601_000, 3600), true);
});

test("parkDurationExceededSec: independent of probe count — many rapid (backoff-bounded) probes never accelerate it", () => {
  const entered = "2026-07-14T00:00:00Z";
  const enteredMs = Date.parse(entered);
  // Even with a huge number of probe attempts, only elapsed wall-clock time matters.
  assert.equal(parkDurationExceededSec(entered, enteredMs + 100, 3600), false);
});

// ── escalationChannel: the channel ladder ───────────────────────────────────────────────────

test("escalationChannel: forge-sourced park -> local fallback (forge presumed unreachable)", () => {
  assert.equal(escalationChannel("forge"), "local");
  assert.equal(escalationChannel("forge", true), "local");
});

test("escalationChannel: llm-sourced park -> forge channel (forge presumed fine)", () => {
  assert.equal(escalationChannel("llm"), "forge");
  assert.equal(escalationChannel("llm", false), "forge");
});

test("escalationChannel: llm-sourced park during a mixed storm (forge episode also open) -> local (never a doomed GitHub write)", () => {
  assert.equal(escalationChannel("llm", true), "local");
});

// ── #374: probeDueWithHint — a known reset instant floors the first useful probe ────────────

test("probeDueWithHint: no hint -> byte-identical to probeDue", () => {
  const last = "2026-07-24T00:00:00Z";
  const lastMs = Date.parse(last);
  assert.equal(probeDueWithHint(last, lastMs + 29_000, 30, null), false);
  assert.equal(probeDueWithHint(last, lastMs + 30_000, 30, null), true);
  assert.equal(probeDueWithHint(null, lastMs, 30, null), true);
});

test("probeDueWithHint: hint in the future withholds the probe even once ordinary backoff would fire", () => {
  const last = "2026-07-24T00:00:00Z";
  const lastMs = Date.parse(last);
  const hint = "2026-07-24T06:30:00Z";
  // Ordinary backoff (30s base) would be due almost immediately; the hint (6.5h out) wins.
  assert.equal(probeDueWithHint(last, lastMs + 60_000, 30, hint), false);
  assert.equal(probeDueWithHint(last, Date.parse(hint) - 1, 30, hint), false);
});

test("probeDueWithHint: due exactly at the hint and after, once ordinary probeDue also agrees", () => {
  const last = "2026-07-24T00:00:00Z";
  const hint = "2026-07-24T06:30:00Z";
  const hintMs = Date.parse(hint);
  // last_probe_at is far enough in the past that ordinary backoff is already satisfied by hintMs.
  assert.equal(probeDueWithHint(last, hintMs, 30, hint), true);
  assert.equal(probeDueWithHint(last, hintMs + 1000, 30, hint), true);
});

test("probeDueWithHint: a malformed hint degrades to plain probeDue, never throws", () => {
  const last = "2026-07-24T00:00:00Z";
  const lastMs = Date.parse(last);
  assert.doesNotThrow(() => probeDueWithHint(last, lastMs + 30_000, 30, "not-a-date"));
  assert.equal(probeDueWithHint(last, lastMs + 30_000, 30, "not-a-date"), true);
});

// ── #374: emptySpinBreached — pure threshold comparison ─────────────────────────────────────

test("emptySpinBreached: below/at/above threshold", () => {
  assert.equal(emptySpinBreached(0, 3), false);
  assert.equal(emptySpinBreached(2, 3), false);
  assert.equal(emptySpinBreached(3, 3), true);
  assert.equal(emptySpinBreached(4, 3), true);
});
