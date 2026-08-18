// sanitize.test.ts (#234, moved here #975): nothing token-bearing in any error surface that
// passes through sanitizeUpstreamError — the forge MCP proxy's typed error text (proxy/tools.ts's
// toolError), and getFailedCheckSummary's own embedded per-source failure reasons (forge.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeUpstreamError } from "./sanitize.js";

test("sanitizeUpstreamError: scrubs GitHub PAT-shaped tokens, Bearer headers, and bare 40-hex strings", () => {
  const raw =
    "gh auth failed: token ghp_ABCDEFGHIJ0123456789abcdefghij for user; " +
    "Authorization: Bearer sk-live-abcdef1234567890; " +
    "sha da39a3ee5e6b4b0d3255bfef95601890afd80709 not found";
  const clean = sanitizeUpstreamError(raw);
  assert.doesNotMatch(clean, /ghp_[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(clean, /Bearer\s+\S+/i);
  assert.doesNotMatch(clean, /\b[0-9a-f]{40}\b/i);
  assert.match(clean, /\[redacted\]/);
});

test("sanitizeUpstreamError: non-string input degrades to a placeholder, never throws", () => {
  assert.doesNotThrow(() => sanitizeUpstreamError(undefined));
  assert.doesNotThrow(() => sanitizeUpstreamError({ some: "object" }));
});

// Round-2 delta review, P2: the userinfo pattern originally required a user:pass PAIR — a bare
// token userinfo (no colon at all) slipped through. Broadened to redact ANY userinfo shape.
test("sanitizeUpstreamError: redacts a BARE-TOKEN URL userinfo (no colon) — e.g. a credentialed git remote shaped like https://<token>@host/...", () => {
  const raw = "fatal: unable to access 'https://ghp_ABCDEFGHIJ0123456789abcdefghij@github.com/owner/repo.git/'";
  const clean = sanitizeUpstreamError(raw);
  assert.doesNotMatch(clean, /ghp_[A-Za-z0-9]{20,}/);
  assert.match(clean, /:\/\/\[redacted\]@github\.com/, "the scheme and host survive, only the userinfo is redacted");
});

test("sanitizeUpstreamError: redacts a user:pass URL userinfo — e.g. https://user:pass@host/...", () => {
  const raw = "fatal: unable to access 'https://someuser:some-secret-pass@github.com/owner/repo.git/'";
  const clean = sanitizeUpstreamError(raw);
  assert.doesNotMatch(clean, /someuser/);
  assert.doesNotMatch(clean, /some-secret-pass/);
  assert.match(clean, /:\/\/\[redacted\]@github\.com/);
});

test("sanitizeUpstreamError: redacts token/access_token/x-access-token query param VALUES, preserving the key name", () => {
  for (const [key, url] of [
    ["token", "https://api.example.com/foo?token=ghp_ABCDEFGHIJ0123456789abcdefghij"],
    ["access_token", "https://api.example.com/foo?access_token=ghp_ABCDEFGHIJ0123456789abcdefghij"],
    ["x-access-token", "https://api.example.com/foo?x-access-token=ghp_ABCDEFGHIJ0123456789abcdefghij"],
  ] as const) {
    const clean = sanitizeUpstreamError(url);
    assert.doesNotMatch(clean, /ghp_[A-Za-z0-9]{20,}/, `${key} value should be redacted`);
    assert.match(clean, new RegExp(`${key}=\\[redacted\\]`, "i"), `${key}= should be preserved verbatim`);
  }
});
