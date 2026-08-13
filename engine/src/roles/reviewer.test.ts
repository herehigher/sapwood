// reviewer.ts tests: pure signal derivation (freshThumbCount, freshHeadReviewCount,
// deriveReviewAction) + the pluggable Reviewer implementations' verdictFromData (pure) and
// triggerReview (against a fake IForge — no real gh calls anywhere in this file).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigSchema } from "../config/config.js";
import { NO_DOCTRINE } from "../config/doctrine.js";
import type { IForge, PRReview, PRReviewData, ReviewThreadSpan } from "../forge/forge.js";
import { findingDigest } from "../forge/forge.js";
import type {
  ApprovalResult,
  Finding,
  ReviewAction,
  ReviewContext,
  Reviewer,
  ReviewerAdapter,
  ReviewFallbackLock,
  ReviewTriggerPin,
  ReviewVerdict,
} from "./reviewer.js";
import {
  adjudicatedDuplicateThreads,
  buildReviewerByKind,
  buildReviewTriggerComment,
  CodexReviewer,
  changesRequestedOnHead,
  deriveBlockingSignal,
  deriveReviewAction,
  freshHeadReviewCount,
  freshThumbCount,
  HumanReviewer,
  isFinding,
  isReviewerKind,
  makeFallbackReviewers,
  makeReviewer,
  NO_FALLBACK_LOCK,
  normalizeLogin,
  oidAssertionMatchesHead,
  REVIEWER_KINDS,
  resolveReviewVerdict,
  SameModelTrustedReviewer,
  staleHeadReviewCount,
  validateFindings,
} from "./reviewer.js";

// ── pure signal helpers ──────────────────────────

test("freshThumbCount: only reactions created AFTER the cutoff count (#92 staleness)", () => {
  const cutoff = "2026-06-17T12:00:00Z";
  const reactions = [
    { content: "+1", createdAt: "2026-06-17T10:00:00Z" }, // stale
    { content: "+1", createdAt: "2026-06-17T13:00:00Z" }, // fresh
    { content: "eyes", createdAt: "2026-06-17T13:30:00Z" }, // not a thumb at all
  ];
  assert.equal(freshThumbCount(reactions, cutoff), 1);
});

test("freshThumbCount: all-stale -> 0", () => {
  assert.equal(freshThumbCount([{ content: "+1", createdAt: "2026-06-17T09:00:00Z" }], "2026-06-17T12:00:00Z"), 0);
});

test("freshThumbCount: mixed precision compares NUMERICALLY — a same-second reaction before a millisecond cutoff is stale (round-2 P2)", () => {
  // Lexicographically "…00Z" > "…00.999Z" (Z sorts after '.'), which would wrongly count a
  // reaction that predates the trigger within the same second. Numeric compare rejects it.
  assert.equal(freshThumbCount([{ content: "+1", createdAt: "2026-07-07T08:00:00Z" }], "2026-07-07T08:00:00.999Z"), 0);
  // Sanity: one full second later IS fresh against the same millisecond cutoff.
  assert.equal(freshThumbCount([{ content: "+1", createdAt: "2026-07-07T08:00:01Z" }], "2026-07-07T08:00:00.999Z"), 1);
});

test("freshThumbCount: unparseable cutoff or createdAt never counts (fail-closed)", () => {
  assert.equal(freshThumbCount([{ content: "+1", createdAt: "2026-07-07T08:00:01Z" }], "not-a-date"), 0);
  assert.equal(freshThumbCount([{ content: "+1", createdAt: "garbage" }], "2026-07-07T08:00:00Z"), 0);
});

const mkReview = (author: string, commitOid: string, state: string): PRReview => ({ author, commitOid, state });

test("freshHeadReviewCount: only non-author reviews on the CURRENT head, in an accepted state, count (#101)", () => {
  const reviews = [
    mkReview("codex", "HEAD", "COMMENTED"), // counts
    mkReview("codex", "OLD", "COMMENTED"), // stale head -> doesn't count
    mkReview("author", "HEAD", "COMMENTED"), // self-review -> doesn't count
  ];
  assert.equal(freshHeadReviewCount(reviews, "HEAD", "author", ["COMMENTED", "APPROVED"]), 1);
});

test("freshHeadReviewCount: a review of an OLD head never counts, even with plenty of other reviews", () => {
  const reviews = [mkReview("codex", "OLD", "COMMENTED")];
  assert.equal(freshHeadReviewCount(reviews, "HEAD", "author", ["COMMENTED", "APPROVED"]), 0);
});

test("freshHeadReviewCount: author self-review on the current head never counts (producer != reviewer)", () => {
  const reviews = [mkReview("author", "HEAD", "COMMENTED")];
  assert.equal(freshHeadReviewCount(reviews, "HEAD", "author", ["COMMENTED", "APPROVED"]), 0);
});

test("freshHeadReviewCount: a DISMISSED review on the current head never counts", () => {
  const reviews = [mkReview("codex", "HEAD", "DISMISSED")];
  assert.equal(freshHeadReviewCount(reviews, "HEAD", "author", ["COMMENTED", "APPROVED"]), 0);
});

test("freshHeadReviewCount: acceptStates restricts which states count (human reviewer wants APPROVED only)", () => {
  const reviews = [mkReview("codex", "HEAD", "COMMENTED")];
  assert.equal(freshHeadReviewCount(reviews, "HEAD", "author", ["APPROVED"]), 0);
  assert.equal(freshHeadReviewCount([mkReview("codex", "HEAD", "APPROVED")], "HEAD", "author", ["APPROVED"]), 1);
});

test("deriveReviewAction: unresolved threads outrank a fresh approving review (findings first)", () => {
  assert.equal(
    deriveReviewAction({
      hasEyesReaction: false,
      freshTrustedThumbs: 0,
      freshApprovingReviews: 1,
      unresolvedThreads: 2,
      changesRequestedOnHead: false,
    }),
    "HANDLE_THREADS",
  );
});

test("deriveReviewAction: a standing change request outranks a fresh approving review (Codex PR #42 P1)", () => {
  assert.equal(
    deriveReviewAction({
      hasEyesReaction: false,
      freshTrustedThumbs: 0,
      freshApprovingReviews: 1,
      unresolvedThreads: 0,
      changesRequestedOnHead: true,
    }),
    "HANDLE_THREADS",
  );
});

test("deriveReviewAction: a fresh approving review with no threads -> MERGE_OK", () => {
  assert.equal(
    deriveReviewAction({
      hasEyesReaction: false,
      freshTrustedThumbs: 0,
      freshApprovingReviews: 1,
      unresolvedThreads: 0,
      changesRequestedOnHead: false,
    }),
    "MERGE_OK",
  );
});

test("deriveReviewAction: nothing yet (no review, no eyes) -> WAIT_REVIEW, never a silent MERGE_OK", () => {
  assert.equal(
    deriveReviewAction({
      hasEyesReaction: false,
      freshTrustedThumbs: 0,
      freshApprovingReviews: 0,
      unresolvedThreads: 0,
      changesRequestedOnHead: false,
    }),
    "WAIT_REVIEW",
  );
  assert.equal(
    deriveReviewAction({
      hasEyesReaction: true,
      freshTrustedThumbs: 0,
      freshApprovingReviews: 0,
      unresolvedThreads: 0,
      changesRequestedOnHead: false,
    }),
    "WAIT_REVIEW",
  );
});

// ── changesRequestedOnHead (Codex PR #42 P1: approve-then-changes-requested must block) ──

test("changesRequestedOnHead: a change request on the current head blocks", () => {
  assert.equal(changesRequestedOnHead([mkReview("rev", "HEAD", "CHANGES_REQUESTED")], "HEAD", "author"), true);
});

test("changesRequestedOnHead: accepted review THEN a later change request on the same head still blocks", () => {
  const reviews = [
    mkReview("codex", "HEAD", "COMMENTED"),
    mkReview("rev", "HEAD", "CHANGES_REQUESTED"), // later CR wins
  ];
  assert.equal(changesRequestedOnHead(reviews, "HEAD", "author"), true);
});

test("changesRequestedOnHead: the SAME reviewer re-approving the same head clears their change request", () => {
  const reviews = [
    mkReview("rev", "HEAD", "CHANGES_REQUESTED"),
    mkReview("rev", "HEAD", "APPROVED"), // reviewer satisfied -> cleared
  ];
  assert.equal(changesRequestedOnHead(reviews, "HEAD", "author"), false);
});

test("changesRequestedOnHead: a mere COMMENTED does NOT clear a standing change request (GitHub semantics)", () => {
  const reviews = [mkReview("rev", "HEAD", "CHANGES_REQUESTED"), mkReview("rev", "HEAD", "COMMENTED")];
  assert.equal(changesRequestedOnHead(reviews, "HEAD", "author"), true);
});

test("changesRequestedOnHead: a change request on an OLD head does not block the current head", () => {
  assert.equal(changesRequestedOnHead([mkReview("rev", "OLD", "CHANGES_REQUESTED")], "HEAD", "author"), false);
});

test("changesRequestedOnHead: a DISMISSED review never blocks (state is DISMISSED, not CHANGES_REQUESTED)", () => {
  assert.equal(changesRequestedOnHead([mkReview("rev", "HEAD", "DISMISSED")], "HEAD", "author"), false);
});

// ── buildReviewTriggerComment (#46, Decision #8: plan-in-trigger) ────────────────────────────

test("buildReviewTriggerComment: includes the extracted plan and asks the reviewer to verify against it", () => {
  const body = buildReviewTriggerComment(46, "## Verification\nrun the test suite");
  assert.match(body, /^@codex review/);
  assert.match(body, /issue #46/);
  assert.match(body, /run the test suite/);
});

test("buildReviewTriggerComment: null plan -> an explicit fallback sentence, never a silent omission", () => {
  const body = buildReviewTriggerComment(46, null);
  assert.match(body, /^@codex review/);
  assert.match(body, /No extractable verification plan/i);
  assert.match(body, /issue #46/);
});

test("buildReviewTriggerComment: first trigger requests the full PR diff and an exact reviewed-head OID statement", () => {
  const body = buildReviewTriggerComment(46, "## Verification\nrun tests", "@codex review", undefined, {
    head: "H1",
    baseHead: null,
  });
  assert.match(body, /full PR diff at head H1/i);
  assert.match(body, /Reviewed commit: H1/);
});

test("buildReviewTriggerComment: a moved head requests only the X..Y delta but binds the verdict to Y", () => {
  const body = buildReviewTriggerComment(46, "## Verification\nrun tests", "@codex review", undefined, {
    head: "H2",
    baseHead: "H1",
  });
  assert.match(body, /H1\.\.H2/);
  assert.match(body, /verdict must bind to the new head H2/i);
  assert.match(body, /Reviewed commit: H2/);
});

// #156: reviewer.triggerCommand — the trigger text is now a parameter (default unchanged).
test("buildReviewTriggerComment: default triggerCommand is byte-for-byte identical to today's hardcoded `@codex review`", () => {
  const body = buildReviewTriggerComment(46, "## Verification\nrun the test suite");
  assert.equal(body, "@codex review\n\nVerify this PR against issue #46's verification plan below:\n\n## Verification\nrun the test suite");
});

test("buildReviewTriggerComment: a custom triggerCommand replaces the default `@codex review` line, instruction unchanged", () => {
  const body = buildReviewTriggerComment(46, "## Verification\nrun the test suite", "/review-please");
  assert.equal(
    body,
    "/review-please\n\nVerify this PR against issue #46's verification plan below:\n\n## Verification\nrun the test suite",
  );
});

// #167: doctrine appended after the verification plan, aimed at pointing the reviewer's
// attention at historical failure zones.
test("buildReviewTriggerComment: doctrine present -> appended AFTER the verification plan", () => {
  const body = buildReviewTriggerComment(
    46,
    "## Verification\nrun the test suite",
    "@codex review",
    "disabled-consumer rule: gate probes on whether the consumer is enabled.",
  );
  assert.match(body, /^@codex review/);
  assert.match(body, /run the test suite/);
  assert.match(body, /disabled-consumer rule/);
  // Order: plan text precedes the doctrine text.
  assert.ok(body.indexOf("run the test suite") < body.indexOf("disabled-consumer rule"));
});

test("buildReviewTriggerComment: doctrine absent (undefined) -> comment is byte-for-byte identical to no-doctrine output, no placeholder text", () => {
  const withoutDoctrineArg = buildReviewTriggerComment(46, "## Verification\nrun the test suite");
  const withUndefinedDoctrine = buildReviewTriggerComment(46, "## Verification\nrun the test suite", "@codex review", undefined);
  assert.equal(withUndefinedDoctrine, withoutDoctrineArg);
  assert.doesNotMatch(withUndefinedDoctrine, /review doctrine/i);
});

test("buildReviewTriggerComment: doctrine null or empty string -> also appends nothing (a public PR comment must never carry the NO_DOCTRINE placeholder)", () => {
  const base = buildReviewTriggerComment(46, "## Verification\nrun the test suite");
  assert.equal(buildReviewTriggerComment(46, "## Verification\nrun the test suite", "@codex review", null), base);
  assert.equal(buildReviewTriggerComment(46, "## Verification\nrun the test suite", "@codex review", ""), base);
});

// #177 review (Codex P2): the never-leaks invariant is structural, not just a caller convention
// — the pure builder itself treats the NO_DOCTRINE placeholder like undefined, so even a caller
// that forgets the construction-boundary mapping cannot leak it into a posted comment.
test("buildReviewTriggerComment: the NO_DOCTRINE placeholder passed DIRECTLY is treated like undefined — byte-for-byte the no-doctrine comment", () => {
  const base = buildReviewTriggerComment(46, "## Verification\nrun the test suite");
  const withPlaceholder = buildReviewTriggerComment(46, "## Verification\nrun the test suite", "@codex review", NO_DOCTRINE);
  assert.equal(withPlaceholder, base);
  assert.doesNotMatch(withPlaceholder, /No review doctrine file is configured/i);
});

// ── Reviewer implementations ───────────────────────────────────────────────────────────────

const mkData = (over: Partial<PRReviewData> = {}): PRReviewData => ({
  headOid: "HEAD",
  author: "producer",
  updatedAt: "2026-06-17T12:00:00Z",
  isDraft: false,
  labels: [],
  state: "OPEN",
  reactions: [],
  reviews: [],
  unresolvedThreads: 0,
  ...over,
});

test("CodexReviewer: a Codex-bot COMMENTED review on the current head is enough (Codex's normal review state)", () => {
  const r = new CodexReviewer();
  const data = mkData({ reviews: [mkReview("chatgpt-codex-connector[bot]", "HEAD", "COMMENTED")] });
  assert.deepEqual(r.verdictFromData(data), {
    action: "MERGE_OK",
    headOid: "HEAD",
    generationResponded: false,
    coverageEstablished: false,
  });
});

test("CodexReviewer: bot login matches with OR without the [bot] suffix (REST vs GraphQL forms)", () => {
  const r = new CodexReviewer();
  assert.equal(r.verdictFromData(mkData({ reviews: [mkReview("chatgpt-codex-connector", "HEAD", "COMMENTED")] })).action, "MERGE_OK");
  assert.equal(normalizeLogin("chatgpt-codex-connector[bot]"), "chatgpt-codex-connector");
});

test("CodexReviewer: a review from a RANDOM non-author account does NOT satisfy gate② (Codex PR #42 P1)", () => {
  const r = new CodexReviewer();
  // Non-author, current head, accepted state — but not the Codex bot and not allowlisted:
  // identity is part of the gate; anyone-but-the-author must never unlock autonomous merge.
  const data = mkData({ reviews: [mkReview("random-account", "HEAD", "APPROVED")] });
  assert.equal(r.verdictFromData(data).action, "WAIT_REVIEW");
});

test("CodexReviewer: cfg trustedReviewers EXTENDS the allowlist (never replaces the Codex bot)", () => {
  const r = new CodexReviewer(["extra-trusted-bot"]);
  assert.equal(r.verdictFromData(mkData({ reviews: [mkReview("extra-trusted-bot", "HEAD", "COMMENTED")] })).action, "MERGE_OK");
  assert.equal(r.verdictFromData(mkData({ reviews: [mkReview("chatgpt-codex-connector", "HEAD", "COMMENTED")] })).action, "MERGE_OK");
  assert.equal(r.verdictFromData(mkData({ reviews: [mkReview("still-random", "HEAD", "COMMENTED")] })).action, "WAIT_REVIEW");
});

// #273 supersedes #55's thumb path: reactions never satisfy gate② because they cannot carry an
// OID. A clean comment must be trusted, post-pin, and assert exactly the current head OID.

const TRIGGER_AT = "2026-07-07T07:40:00Z"; // engine-recorded trigger time (the pin)
const PIN = { head: "HEAD", at: TRIGGER_AT };

const CLEAN = "Codex Review: Didn't find any major issues.";

test("CodexReviewer #273: an OID-less clean comment never satisfies gate②, even on generation 1", () => {
  const r = new CodexReviewer();
  const data = mkData({
    comments: [{ login: "chatgpt-codex-connector[bot]", createdAt: "2026-07-07T07:48:44Z", body: CLEAN }],
  });
  assert.deepEqual(r.verdictFromData(data, PIN), {
    action: "WAIT_REVIEW",
    headOid: "HEAD",
    generationResponded: false,
    coverageEstablished: false,
  });
});

test("CodexReviewer #273: exactly one matching OID assertion satisfies the canonical clean-comment path", () => {
  const data = mkData({
    comments: [
      {
        login: "chatgpt-codex-connector[bot]",
        createdAt: "2026-07-07T07:48:44Z",
        body: `${CLEAN}\nReviewed head OID: HEAD`,
      },
    ],
  });
  assert.equal(new CodexReviewer().verdictFromData(data, PIN).action, "MERGE_OK");
});

test("CodexReviewer #273: inline-code negation and mid-prose phrase embeddings are not verdict lines", () => {
  const comment = { login: "chatgpt-codex-connector[bot]", createdAt: "2026-07-07T07:48:44Z" };
  const bodies = [
    `I cannot honestly return \`${CLEAN}\` because the merge logic is unsafe.\nReviewed head OID: HEAD`,
    `The phrase ${CLEAN} would be incorrect here.\nReviewed head OID: HEAD`,
  ];
  const r = new CodexReviewer();
  for (const body of bodies) {
    assert.equal(r.verdictFromData(mkData({ comments: [{ ...comment, body }] }), PIN).action, "WAIT_REVIEW", body);
  }
});

test("CodexReviewer #273: emphasis-only decoration around the standalone canonical line is accepted", () => {
  const data = mkData({
    comments: [
      {
        login: "chatgpt-codex-connector[bot]",
        createdAt: "2026-07-07T07:48:44Z",
        body: `**${CLEAN}**\nReviewed head OID: HEAD`,
      },
    ],
  });
  assert.equal(new CodexReviewer().verdictFromData(data, PIN).action, "MERGE_OK");
});

test("CodexReviewer #273: verdict indentation permits 0-3 spaces but rejects indented-code and tabs", () => {
  const r = new CodexReviewer();
  const comment = { login: "chatgpt-codex-connector[bot]", createdAt: "2026-07-07T07:48:44Z" };
  for (const spaces of [" ", "  ", "   "]) {
    const data = mkData({ comments: [{ ...comment, body: `${spaces}${CLEAN}\nReviewed head OID: HEAD` }] });
    assert.equal(r.verdictFromData(data, PIN).action, "MERGE_OK", JSON.stringify(spaces));
  }
  for (const indentation of ["    ", "\t"]) {
    const data = mkData({ comments: [{ ...comment, body: `${indentation}${CLEAN}\nReviewed head OID: HEAD` }] });
    assert.equal(r.verdictFromData(data, PIN).action, "WAIT_REVIEW", JSON.stringify(indentation));
  }
});

test("CodexReviewer #273: OID assertions remain column-0 anchored", () => {
  const data = mkData({
    comments: [
      {
        login: "chatgpt-codex-connector[bot]",
        createdAt: "2026-07-07T07:48:44Z",
        body: `${CLEAN}\n    Reviewed head OID: HEAD`,
      },
    ],
  });
  assert.equal(new CodexReviewer().verdictFromData(data, PIN).action, "WAIT_REVIEW");
});

test("CodexReviewer #273: delayed prior-generation clean comment cannot satisfy an ambiguous H2 pin; an H2-quoting response can", () => {
  const r = new CodexReviewer();
  const pin = { head: "H2", at: "2026-07-07T08:00:00Z", generation: 2, ambiguous: true };
  const delayed = mkData({
    headOid: "H2",
    comments: [{ login: "chatgpt-codex-connector[bot]", createdAt: "2026-07-07T08:01:00Z", body: CLEAN }],
  });
  assert.equal(r.verdictFromData(delayed, pin).action, "WAIT_REVIEW");

  const answered = {
    ...delayed,
    comments: [
      ...delayed.comments!,
      {
        login: "chatgpt-codex-connector[bot]",
        createdAt: "2026-07-07T08:02:00Z",
        body: `${CLEAN}\nReviewed head OID: H2`,
      },
    ],
  };
  assert.equal(r.verdictFromData(answered, pin).action, "MERGE_OK");
});

test("CodexReviewer #273: a +1 stays WAIT_REVIEW in an ambiguous generation", () => {
  const r = new CodexReviewer();
  const data = mkData({
    headOid: "H2",
    reactions: [{ content: "+1", createdAt: "2026-07-07T08:01:00Z", login: "chatgpt-codex-connector[bot]" }],
  });
  assert.equal(r.verdictFromData(data, { head: "H2", at: "2026-07-07T08:00:00Z", generation: 2, ambiguous: true }).action, "WAIT_REVIEW");
});

test("CodexReviewer #273: generation > 1 permanently rejects OID-less comments and thumbs even when ambiguity/in-flight cleared", () => {
  const r = new CodexReviewer();
  const pin = { head: "H3", at: "2026-07-07T08:00:00Z", generation: 3, ambiguous: false, inFlight: false };
  const data = mkData({
    headOid: "H3",
    reactions: [{ content: "+1", createdAt: "2026-07-07T08:01:00Z", login: "chatgpt-codex-connector[bot]" }],
    comments: [{ login: "chatgpt-codex-connector[bot]", createdAt: "2026-07-07T08:02:00Z", body: CLEAN }],
  });
  assert.equal(r.verdictFromData(data, pin).action, "WAIT_REVIEW");
});

test("CodexReviewer #273: quoted OID prose cannot spoof an assertion", () => {
  const data = mkData({
    headOid: "H2",
    comments: [
      {
        login: "chatgpt-codex-connector[bot]",
        createdAt: "2026-07-07T08:01:00Z",
        body: `> Requested format: Reviewed head OID: H2\n${CLEAN}`,
      },
    ],
  });
  assert.equal(new CodexReviewer().verdictFromData(data, { head: "H2", at: "2026-07-07T08:00:00Z", generation: 2 }).action, "WAIT_REVIEW");
});

test("CodexReviewer #273: verdict text and OID inside fenced or HTML-comment content are discarded", () => {
  const quotedBodies = [
    `Prose outside.\n\`\`\`text\n${CLEAN}\nReviewed head OID: HEAD\n\`\`\``,
    `Prose outside.\n~~~text\n${CLEAN}\nReviewed head OID: HEAD\n~~~`,
    `Prose outside.\n<!--\n${CLEAN}\nReviewed head OID: HEAD\n-->`,
    `Prose outside.\n\`\`\`text\n${CLEAN}\nReviewed head OID: HEAD`,
    `Prose outside.\n<!-- ${CLEAN}\nReviewed head OID: HEAD`,
  ];
  const r = new CodexReviewer();
  for (const body of quotedBodies) {
    const data = mkData({ comments: [{ login: "chatgpt-codex-connector[bot]", createdAt: "2026-07-07T07:48:44Z", body }] });
    assert.equal(r.verdictFromData(data, PIN).action, "WAIT_REVIEW", body);
  }
});

test("CodexReviewer #273: an HTML comment cannot be deleted into a valid fence closer", () => {
  const data = mkData({
    comments: [
      {
        login: "chatgpt-codex-connector[bot]",
        createdAt: "2026-07-07T07:48:44Z",
        body: `\`\`\`text\nquoted example\n\`\`\` <!-- x -->\n${CLEAN}\nReviewed head OID: HEAD`,
      },
    ],
  });
  assert.equal(new CodexReviewer().verdictFromData(data, PIN).action, "WAIT_REVIEW");
});

test("CodexReviewer #273: lazy blockquote continuation is quarantined until a blank line", () => {
  const r = new CodexReviewer();
  const comment = { login: "chatgpt-codex-connector[bot]", createdAt: "2026-07-07T07:48:44Z" };
  const lazyQuoted = mkData({
    comments: [{ ...comment, body: `> quoted review example\n${CLEAN}\n\nReviewed head OID: HEAD` }],
  });
  assert.equal(r.verdictFromData(lazyQuoted, PIN).action, "WAIT_REVIEW");

  const afterBlank = mkData({
    comments: [{ ...comment, body: `> quoted review example\nquoted continuation\n\n${CLEAN}\nReviewed head OID: HEAD` }],
  });
  assert.equal(r.verdictFromData(afterBlank, PIN).action, "MERGE_OK");
});

test("CodexReviewer #273: an incidental fenced snippet does not hide a normal OID-bound verdict", () => {
  const data = mkData({
    comments: [
      {
        login: "chatgpt-codex-connector[bot]",
        createdAt: "2026-07-07T07:48:44Z",
        body: `Incidental example:\n\`\`\`ts\nconst reviewed = true;\n\`\`\`\n${CLEAN}\nReviewed head OID: HEAD`,
      },
    ],
  });
  assert.equal(new CodexReviewer().verdictFromData(data, PIN).action, "MERGE_OK");
});

test("CodexReviewer #273: conflicting OID assertions are discarded; repeated one-value assertions are accepted", () => {
  const base = {
    login: "chatgpt-codex-connector[bot]",
    createdAt: "2026-07-07T08:01:00Z",
  };
  const pin = { head: "H2", at: "2026-07-07T08:00:00Z", generation: 2 };
  const r = new CodexReviewer();
  assert.equal(
    r.verdictFromData(
      mkData({ headOid: "H2", comments: [{ ...base, body: `${CLEAN}\nReviewed head OID: H2\nReviewed head OID: H1` }] }),
      pin,
    ).action,
    "WAIT_REVIEW",
  );
  assert.equal(
    r.verdictFromData(
      mkData({ headOid: "H2", comments: [{ ...base, body: `${CLEAN}\nReviewed head OID: H2\nReviewed head OID: H2` }] }),
      pin,
    ).action,
    "MERGE_OK",
  );
});

test("CodexReviewer #273: an explicitly stated mismatching OID discards a clean comment even when the pin is unambiguous", () => {
  const r = new CodexReviewer();
  const data = mkData({
    headOid: "H2",
    comments: [
      {
        login: "chatgpt-codex-connector[bot]",
        createdAt: "2026-07-07T08:01:00Z",
        body: `${CLEAN}\nReviewed head OID: H1`,
      },
    ],
  });
  assert.equal(r.verdictFromData(data, { head: "H2", at: "2026-07-07T08:00:00Z", ambiguous: false }).action, "WAIT_REVIEW");
});

test("CodexReviewer: clean comment BEFORE the trigger pin is stale -> WAIT_REVIEW", () => {
  const r = new CodexReviewer();
  const data = mkData({
    comments: [{ login: "chatgpt-codex-connector[bot]", createdAt: "2026-07-07T07:39:59Z", body: `${CLEAN}\nReviewed head OID: HEAD` }],
  });
  assert.equal(r.verdictFromData(data, PIN).action, "WAIT_REVIEW");
});

test("CodexReviewer: an UNTRUSTED account posting the clean phrase never satisfies gate②", () => {
  const r = new CodexReviewer();
  const data = mkData({
    comments: [{ login: "random-account", createdAt: "2026-07-07T07:48:44Z", body: `${CLEAN}\nReviewed head OID: HEAD` }],
  });
  assert.equal(r.verdictFromData(data, PIN).action, "WAIT_REVIEW");
});

test("CodexReviewer: the PR AUTHOR posting the clean phrase never counts (producer≠reviewer), even when trusted", () => {
  const r = new CodexReviewer();
  const data = mkData({
    author: "chatgpt-codex-connector",
    comments: [{ login: "chatgpt-codex-connector[bot]", createdAt: "2026-07-07T07:48:44Z", body: `${CLEAN}\nReviewed head OID: HEAD` }],
  });
  assert.equal(r.verdictFromData(data, PIN).action, "WAIT_REVIEW");
});

test("CodexReviewer: a trusted comment WITHOUT the clean phrase keeps waiting (narrow match, fail-closed)", () => {
  const r = new CodexReviewer();
  const data = mkData({
    comments: [
      {
        login: "chatgpt-codex-connector[bot]",
        createdAt: "2026-07-07T07:48:44Z",
        body: "Codex Review: still looking 👀\nReviewed head OID: HEAD",
      },
    ],
  });
  assert.equal(r.verdictFromData(data, PIN).action, "WAIT_REVIEW");
});

test("CodexReviewer: clean comment + unresolved threads -> HANDLE_THREADS (findings still outrank)", () => {
  const r = new CodexReviewer();
  const data = mkData({
    unresolvedThreads: 1,
    comments: [{ login: "chatgpt-codex-connector[bot]", createdAt: "2026-07-07T07:48:44Z", body: `${CLEAN}\nReviewed head OID: HEAD` }],
  });
  assert.equal(r.verdictFromData(data, PIN).action, "HANDLE_THREADS");
});

test("CodexReviewer P1: stale unresolved threads alone do not attribute a response to the current trigger generation", () => {
  const verdict = new CodexReviewer().verdictFromData(mkData({ unresolvedThreads: 2 }), PIN);
  assert.equal(verdict.action, "HANDLE_THREADS");
  assert.equal(verdict.generationResponded, false);
});

test("CodexReviewer P1: a countable current-head formal response after the pin closes the generation regardless of review state", () => {
  const verdict = new CodexReviewer().verdictFromData(
    mkData({
      reviews: [
        {
          author: "chatgpt-codex-connector[bot]",
          commitOid: "HEAD",
          state: "DISMISSED",
          submittedAt: "2026-07-07T07:41:00Z",
        },
      ],
    }),
    PIN,
  );
  assert.equal(verdict.action, "WAIT_REVIEW");
  assert.equal(verdict.generationResponded, true);
  assert.equal(verdict.coverageEstablished, true);
});

test("CodexReviewer #273: a third-party CHANGES_REQUESTED responds but never establishes trusted coverage", () => {
  const verdict = new CodexReviewer().verdictFromData(
    mkData({
      reviews: [
        {
          author: "random-account",
          commitOid: "HEAD",
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-07-07T07:41:00Z",
        },
      ],
    }),
    PIN,
  );
  assert.equal(verdict.action, "HANDLE_THREADS");
  assert.equal(verdict.generationResponded, true);
  assert.equal(verdict.coverageEstablished, false);
});

test("CodexReviewer #273: a trusted fresh 👍 never satisfies gate②", () => {
  const r = new CodexReviewer();
  const data = mkData({
    reactions: [{ content: "+1", createdAt: "2026-07-07T07:48:43Z", login: "chatgpt-codex-connector[bot]" }],
  });
  assert.deepEqual(r.verdictFromData(data, PIN), {
    action: "WAIT_REVIEW",
    headOid: "HEAD",
    generationResponded: false,
    coverageEstablished: false,
  });
});

test("CodexReviewer: a RANDOM account's 👍 never satisfies gate② (identity is part of the gate)", () => {
  const r = new CodexReviewer();
  const data = mkData({
    reactions: [{ content: "+1", createdAt: "2026-07-07T07:48:43Z", login: "random-account" }],
  });
  assert.equal(r.verdictFromData(data, PIN).action, "WAIT_REVIEW");
});

test("CodexReviewer: a 👍 OLDER than the engine-recorded trigger time is stale (#55 P1-B — the trigger, not a push, is the pin)", () => {
  const r = new CodexReviewer();
  const data = mkData({
    reactions: [{ content: "+1", createdAt: "2026-07-07T07:39:59Z", login: "chatgpt-codex-connector[bot]" }],
  });
  assert.equal(r.verdictFromData(data, PIN).action, "WAIT_REVIEW");
});

test("CodexReviewer: no trigger pin at all -> thumbs never count (fail-closed)", () => {
  const r = new CodexReviewer();
  const data = mkData({
    reactions: [{ content: "+1", createdAt: "2026-07-07T07:48:43Z", login: "chatgpt-codex-connector[bot]" }],
  });
  assert.equal(r.verdictFromData(data).action, "WAIT_REVIEW"); // pin omitted entirely
  assert.equal(r.verdictFromData(data, { head: null, at: null }).action, "WAIT_REVIEW");
});

test("CodexReviewer: a trigger pin recorded for a DIFFERENT head -> thumbs never count (#55 P1-B — a push invalidates the pin)", () => {
  const r = new CodexReviewer();
  const data = mkData({
    reactions: [{ content: "+1", createdAt: "2026-07-07T07:48:43Z", login: "chatgpt-codex-connector[bot]" }],
  });
  assert.equal(r.verdictFromData(data, { head: "OLD_HEAD_BEFORE_PUSH", at: TRIGGER_AT }).action, "WAIT_REVIEW");
});

test("CodexReviewer: the PR AUTHOR's own 👍 never counts, even when the author's login is itself trusted (#55 P1-A, producer != reviewer)", () => {
  const r = new CodexReviewer(["chatgpt-codex-connector"]); // author is also the codex bot login
  const data = mkData({
    author: "chatgpt-codex-connector",
    reactions: [{ content: "+1", createdAt: "2026-07-07T07:48:43Z", login: "chatgpt-codex-connector[bot]" }],
  });
  assert.equal(r.verdictFromData(data, PIN).action, "WAIT_REVIEW");
});

test("SameModelTrustedReviewer: the PR AUTHOR's own 👍 never counts, even when the producer is in the trusted list (#55 P1-A)", () => {
  const r = new SameModelTrustedReviewer(["producer-bot"]);
  const data = mkData({
    author: "producer-bot",
    reactions: [{ content: "+1", createdAt: "2026-07-07T07:48:43Z", login: "producer-bot" }],
  });
  assert.equal(r.verdictFromData(data, PIN).action, "WAIT_REVIEW");
});

test("SameModelTrustedReviewer #273: a different trusted login's 👍 still cannot bind to an OID", () => {
  const r = new SameModelTrustedReviewer(["producer-bot", "trusted-reviewer-bot"]);
  const data = mkData({
    author: "producer-bot",
    reactions: [{ content: "+1", createdAt: "2026-07-07T07:48:43Z", login: "trusted-reviewer-bot" }],
  });
  assert.equal(r.verdictFromData(data, PIN).action, "WAIT_REVIEW");
});

test("CodexReviewer #273: an ignored trusted 👍 cannot soften unresolved threads", () => {
  const r = new CodexReviewer();
  const data = mkData({
    unresolvedThreads: 1,
    reactions: [{ content: "+1", createdAt: "2026-07-07T07:48:43Z", login: "chatgpt-codex-connector[bot]" }],
  });
  assert.equal(r.verdictFromData(data, PIN).action, "HANDLE_THREADS");
});

test("HumanReviewer: thumbs do NOT satisfy gate② in human mode (approval = a real review)", () => {
  const r = new HumanReviewer();
  const data = mkData({
    reactions: [{ content: "+1", createdAt: "2026-07-07T07:48:43Z", login: "some-human" }],
  });
  assert.equal(r.verdictFromData(data, PIN).action, "WAIT_REVIEW");
});

test("CodexReviewer: approve-then-CHANGES_REQUESTED on the same head blocks — never MERGE_OK (Codex PR #42 P1)", () => {
  const r = new CodexReviewer();
  const data = mkData({
    reviews: [
      mkReview("chatgpt-codex-connector", "HEAD", "COMMENTED"), // gate②-satisfying review...
      mkReview("second-reviewer", "HEAD", "CHANGES_REQUESTED"), // ...then a standing CR
    ],
  });
  assert.equal(r.verdictFromData(data).action, "HANDLE_THREADS");
});

test("CodexReviewer: a change request from an UNLISTED account still blocks (filter shrinks approvals, never blockers)", () => {
  const r = new CodexReviewer();
  const data = mkData({
    reviews: [mkReview("chatgpt-codex-connector", "HEAD", "APPROVED"), mkReview("random-account", "HEAD", "CHANGES_REQUESTED")],
  });
  assert.equal(r.verdictFromData(data).action, "HANDLE_THREADS");
});

test("CodexReviewer: a review of a STALE head counts as no review (#101 — the exact bypass gate② closes)", () => {
  const r = new CodexReviewer();
  const data = mkData({ reviews: [mkReview("chatgpt-codex-connector[bot]", "OLD_HEAD", "APPROVED")] });
  assert.equal(r.verdictFromData(data).action, "WAIT_REVIEW");
});

test("CodexReviewer: unresolved threads -> HANDLE_THREADS even with an approving review present", () => {
  const r = new CodexReviewer();
  const data = mkData({
    reviews: [mkReview("chatgpt-codex-connector[bot]", "HEAD", "APPROVED")],
    unresolvedThreads: 2,
  });
  assert.equal(r.verdictFromData(data).action, "HANDLE_THREADS");
});

test("CodexReviewer: triggerReview posts `@codex review` plus the issue's extracted verification plan (#46 Decision #8)", async () => {
  const calls: Array<[number, string]> = [];
  const forge = {
    addPRComment: async (pr: number, body: string) => void calls.push([pr, body]),
    getIssueBody: async () => "## Verification\nrun `npm test`",
  } as unknown as IForge;
  await new CodexReviewer().triggerReview(forge, 42, 46);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], 42);
  assert.match(calls[0]![1], /^@codex review/);
  assert.match(calls[0]![1], /issue #46/);
  assert.match(calls[0]![1], /run `npm test`/);
});

test("CodexReviewer: triggerReview falls back to explicit text when the issue has no extractable plan (never a silent omission)", async () => {
  const calls: Array<[number, string]> = [];
  const forge = {
    addPRComment: async (pr: number, body: string) => void calls.push([pr, body]),
    getIssueBody: async () => "no plan section here",
  } as unknown as IForge;
  await new CodexReviewer().triggerReview(forge, 42, 46);
  assert.match(calls[0]![1], /^@codex review/);
  assert.match(calls[0]![1], /No extractable verification plan/i);
  assert.match(calls[0]![1], /issue #46/);
});

test("CodexReviewer: triggerReview still fires (with the fallback text) when getIssueBody itself fails", async () => {
  const calls: Array<[number, string]> = [];
  const forge = {
    addPRComment: async (pr: number, body: string) => void calls.push([pr, body]),
    getIssueBody: async () => {
      throw new Error("rate limited");
    },
  } as unknown as IForge;
  await new CodexReviewer().triggerReview(forge, 42, 46);
  assert.equal(calls.length, 1); // the trigger still posts — never silently skipped
  assert.match(calls[0]![1], /^@codex review/);
  assert.match(calls[0]![1], /No extractable verification plan/i);
});

test("CodexReviewer: a custom triggerCommand (#156 reviewer.triggerCommand) is used instead of the default `@codex review`", async () => {
  const calls: Array<[number, string]> = [];
  const forge = {
    addPRComment: async (pr: number, body: string) => void calls.push([pr, body]),
    getIssueBody: async () => "no plan section here",
  } as unknown as IForge;
  await new CodexReviewer([], "/review-please").triggerReview(forge, 42, 46);
  assert.match(calls[0]![1], /^\/review-please/);
  assert.doesNotMatch(calls[0]![1], /@codex review/);
});

test("makeReviewer: threads cfg.reviewer.triggerCommand into the built CodexReviewer's trigger comment", async () => {
  // #501: reviewer.mode's own default flipped to engine-agent (makeReviewer cannot construct
  // that kind — see the dedicated #501 test below); pin different-model-codex explicitly since
  // this test is specifically about the CodexReviewer construction path.
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    reviewer: { mode: "different-model-codex", triggerCommand: "/review-please" },
  });
  const calls: Array<[number, string]> = [];
  const forge = {
    addPRComment: async (pr: number, body: string) => void calls.push([pr, body]),
    getIssueBody: async () => "no plan section here",
  } as unknown as IForge;
  await makeReviewer(cfg).triggerReview(forge, 42, 46);
  assert.match(calls[0]![1], /^\/review-please/);
});

// #167: CodexReviewer's own trigger comment carries the review doctrine, when constructed with one.
test("CodexReviewer: a constructed doctrine is appended to the trigger comment, after the verification plan", async () => {
  const calls: Array<[number, string]> = [];
  const forge = {
    addPRComment: async (pr: number, body: string) => void calls.push([pr, body]),
    getIssueBody: async () => "## Verification\nrun the test suite",
  } as unknown as IForge;
  await new CodexReviewer([], "@codex review", "same-tick window rule: never a pre-tick scalar.").triggerReview(forge, 42, 46);
  assert.match(calls[0]![1], /run the test suite/);
  assert.match(calls[0]![1], /same-tick window rule/);
  assert.ok(calls[0]![1].indexOf("run the test suite") < calls[0]![1].indexOf("same-tick window rule"));
});

test("CodexReviewer: no doctrine constructed -> trigger comment unchanged, no placeholder text ever appears", async () => {
  const calls: Array<[number, string]> = [];
  const forge = {
    addPRComment: async (pr: number, body: string) => void calls.push([pr, body]),
    getIssueBody: async () => "## Verification\nrun the test suite",
  } as unknown as IForge;
  await new CodexReviewer().triggerReview(forge, 42, 46);
  assert.doesNotMatch(calls[0]![1], /review doctrine/i);
  assert.doesNotMatch(calls[0]![1], /No review doctrine file is configured/i);
});

// #167: makeReviewer resolves cfg.doctrine the same way it resolves cfg.reviewer.triggerCommand
// — loaded once at construction and threaded into the built CodexReviewer.
test("makeReviewer: threads cfg.doctrine into the built CodexReviewer's trigger comment when a doctrine file is present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-reviewer-doctrine-"));
  try {
    const path = join(dir, "REVIEW-DOCTRINE.md");
    writeFileSync(path, "disabled-consumer rule: gate probes on consumer enablement.");
    // #501: pin different-model-codex explicitly — reviewer.mode's own default is now
    // engine-agent, and this test is specifically about the CodexReviewer construction path.
    const cfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 1 },
      reviewer: { mode: "different-model-codex" },
      doctrine: { file: path },
    });
    const calls: Array<[number, string]> = [];
    const forge = {
      addPRComment: async (pr: number, body: string) => void calls.push([pr, body]),
      getIssueBody: async () => "## Verification\nrun the test suite",
    } as unknown as IForge;
    await makeReviewer(cfg).triggerReview(forge, 42, 46);
    assert.match(calls[0]![1], /run the test suite/);
    assert.match(calls[0]![1], /disabled-consumer rule/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("makeReviewer: no doctrine file adopted -> the trigger comment is byte-for-byte identical to before #167, never the NO_DOCTRINE placeholder", async () => {
  // #501: pin different-model-codex explicitly (reviewer.mode's own default is now engine-agent).
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    reviewer: { mode: "different-model-codex" },
    doctrine: { file: "/nonexistent/REVIEW-DOCTRINE.md" },
  });
  const calls: Array<[number, string]> = [];
  const forge = {
    addPRComment: async (pr: number, body: string) => void calls.push([pr, body]),
    getIssueBody: async () => "## Verification\nrun the test suite",
  } as unknown as IForge;
  await makeReviewer(cfg).triggerReview(forge, 42, 46);
  assert.equal(
    calls[0]![1],
    "@codex review\n\nVerify this PR against issue #46's verification plan below:\n\n## Verification\nrun the test suite",
  );
  assert.doesNotMatch(calls[0]![1], /No review doctrine file is configured/i);
});

test("HumanReviewer: only an explicit APPROVED state counts — a mere COMMENTED does not", () => {
  const r = new HumanReviewer();
  assert.equal(r.verdictFromData(mkData({ reviews: [mkReview("alice", "HEAD", "COMMENTED")] })).action, "WAIT_REVIEW");
  assert.equal(r.verdictFromData(mkData({ reviews: [mkReview("alice", "HEAD", "APPROVED")] })).action, "MERGE_OK");
});

test("HumanReviewer #273: a post-pin current-head formal response establishes coverage", () => {
  const verdict = new HumanReviewer().verdictFromData(
    mkData({
      reviews: [{ author: "reviewer", commitOid: "HEAD", state: "COMMENTED", submittedAt: "2026-07-07T07:41:00Z" }],
    }),
    PIN,
  );
  assert.equal(verdict.action, "WAIT_REVIEW");
  assert.equal(verdict.generationResponded, true);
  assert.equal(verdict.coverageEstablished, true);
});

test("HumanReviewer: triggerReview is a no-op (nothing to ping)", async () => {
  let called = false;
  const forge = {
    addPRComment: async () => {
      called = true;
    },
  } as unknown as IForge;
  const r: Reviewer = new HumanReviewer();
  await r.triggerReview(forge, 1, 46);
  assert.equal(called, false);
});

test("SameModelTrustedReviewer: an empty trustedReviewers list NEVER produces MERGE_OK (fail-closed, not a footgun)", () => {
  const r = new SameModelTrustedReviewer([]);
  const data = mkData({ reviews: [mkReview("anyone", "HEAD", "APPROVED")] });
  assert.equal(r.verdictFromData(data).action, "WAIT_REVIEW");
});

test("SameModelTrustedReviewer: only a NAMED trusted login's approval counts — an untrusted approver does not", () => {
  const r = new SameModelTrustedReviewer(["trusted-bot"]);
  assert.equal(r.verdictFromData(mkData({ reviews: [mkReview("random-user", "HEAD", "APPROVED")] })).action, "WAIT_REVIEW");
  assert.equal(r.verdictFromData(mkData({ reviews: [mkReview("trusted-bot", "HEAD", "APPROVED")] })).action, "MERGE_OK");
});

test("makeReviewer: selects the configured reviewer kind for each Reviewer-implementing mode", () => {
  // #501: reviewer.mode's own default flipped to engine-agent, which makeReviewer cannot
  // construct (see the dedicated #501 test below) — pin different-model-codex explicitly here
  // since this test is about the three Reviewer-implementing kinds makeReviewer DOES build.
  const codex = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    reviewer: { mode: "different-model-codex" },
  });
  assert.ok(makeReviewer(codex) instanceof CodexReviewer);

  const human = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 }, reviewer: { mode: "human" } });
  assert.ok(makeReviewer(human) instanceof HumanReviewer);

  const trusted = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    reviewer: { mode: "same-model-trusted", trustedReviewers: ["bot"] },
  });
  assert.ok(makeReviewer(trusted) instanceof SameModelTrustedReviewer);
});

test("#501: makeReviewer throws for the (now-default) engine-agent mode — production wiring (cli.ts) never calls it in that case, always using review/production.ts's dependency-rich construction path instead", () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  assert.equal(cfg.reviewer.mode, "engine-agent"); // #501's new zero-config default
  assert.throws(() => makeReviewer(cfg), /engine-agent.*constructed via engine-agent\.ts's makeEngineAgentReviewer/);
});

// ── buildReviewerByKind / makeFallbackReviewers (#54) ────────────────────────────────────────

test("buildReviewerByKind: builds the same implementation makeReviewer would for each kind", () => {
  assert.ok(buildReviewerByKind("human", []) instanceof HumanReviewer);
  assert.ok(buildReviewerByKind("same-model-trusted", ["bot"]) instanceof SameModelTrustedReviewer);
  assert.ok(buildReviewerByKind("different-model-codex", []) instanceof CodexReviewer);
});

test("makeFallbackReviewers: empty by default (config default reviewer.fallback: [])", () => {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  assert.deepEqual(makeFallbackReviewers(cfg), []);
});

test("makeFallbackReviewers: builds one Reviewer per configured kind, in order, sharing trustedReviewers", () => {
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    reviewer: { trustedReviewers: ["trusted-bot"], fallback: ["same-model-trusted", "human"] },
  });
  const chain = makeFallbackReviewers(cfg);
  assert.equal(chain.length, 2);
  assert.ok(chain[0] instanceof SameModelTrustedReviewer);
  assert.ok(chain[1] instanceof HumanReviewer);
  assert.equal(chain[0]!.verdictFromData(mkData({ reviews: [mkReview("trusted-bot", "HEAD", "APPROVED")] })).action, "MERGE_OK");
});

// #167: a codex-kind fallback entry gets the same resolved doctrine text as the primary would
// (buildReviewerByKind threads it identically to triggerCommand) — symmetry, even though
// merge-driver.ts doesn't call triggerReview on a fallback today.
test("makeFallbackReviewers: a different-model-codex fallback entry also carries the resolved doctrine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-reviewer-doctrine-"));
  try {
    const path = join(dir, "REVIEW-DOCTRINE.md");
    writeFileSync(path, "crash-rerun set: persist-before-terminal-transition.");
    const cfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 1 },
      doctrine: { file: path },
      reviewer: { fallback: ["different-model-codex"] },
    });
    const chain = makeFallbackReviewers(cfg);
    assert.equal(chain.length, 1);
    const calls: Array<[number, string]> = [];
    const forge = {
      addPRComment: async (pr: number, body: string) => void calls.push([pr, body]),
      getIssueBody: async () => "no plan section here",
    } as unknown as IForge;
    await chain[0]!.triggerReview(forge, 42, 46);
    assert.match(calls[0]![1], /crash-rerun set/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── resolveReviewVerdict (#54): the reviewer-failover decision core ──────────────────────────

class ScriptedReviewer implements Reviewer {
  constructor(
    readonly kind: Reviewer["kind"],
    private readonly action: ReviewAction,
  ) {}
  async triggerReview(): Promise<void> {}
  verdictFromData(data: PRReviewData): ReviewVerdict {
    return { action: this.action, headOid: this.action === "REVIEW_UNAVAILABLE" ? null : data.headOid };
  }
}

const HEAD = "HEAD";
const TRIGGERED_LONG_AGO = { head: HEAD, at: "2026-01-01T00:00:00Z" };
const NOW = new Date("2026-01-01T01:00:00Z"); // 1h after the trigger
const FAILOVER_AFTER_SEC = 1200; // 20min — well under the 1h elapsed above

test("isReviewerKind: accepts exactly the three Reviewer kinds, rejects anything else (#54 R2 read-boundary validation)", () => {
  for (const k of REVIEWER_KINDS) assert.equal(isReviewerKind(k), true);
  assert.equal(isReviewerKind("totally-bogus"), false);
  assert.equal(isReviewerKind(""), false);
  assert.equal(isReviewerKind(null), false);
  assert.equal(isReviewerKind(undefined), false);
  assert.equal(isReviewerKind(42), false);
});

test('#286 (E4a): isReviewerKind rejects "engine-agent" — it must NOT validate as a persisted fallback kind (engine-agent is primary-only, never legal in review_fallback_kind)', () => {
  assert.equal(isReviewerKind("engine-agent"), false);
  assert.ok(!(REVIEWER_KINDS as readonly string[]).includes("engine-agent"));
});

test('#286 (E4a): buildReviewerByKind("engine-agent", ...) throws a clear, specific error naming makeEngineAgentReviewer/#287 — never silently mis-constructs a Codex/human/same-model-trusted reviewer', () => {
  assert.throws(() => buildReviewerByKind("engine-agent", []), /makeEngineAgentReviewer|engine-agent/);
  // Never falls through to CodexReviewer (the #282 exhaustiveness AC this factory guards).
  try {
    buildReviewerByKind("engine-agent", []);
    assert.fail('expected buildReviewerByKind("engine-agent", ...) to throw');
  } catch (e) {
    assert.ok(e instanceof Error);
    assert.doesNotMatch((e as Error).message, /^$/);
  }
});

test("resolveReviewVerdict: no fallback configured -> always the primary's own verdict, no lock, no transition (unchanged behavior)", async () => {
  const primary = new ScriptedReviewer("different-model-codex", "WAIT_REVIEW");
  const result = await resolveReviewVerdict({
    primary,
    fallbacks: [],
    data: mkData(),
    triggerPin: TRIGGERED_LONG_AGO,
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock: NO_FALLBACK_LOCK,
  });
  assert.deepEqual(result.verdict, { action: "WAIT_REVIEW", headOid: HEAD });
  assert.equal(result.sourceKind, "different-model-codex");
  assert.deepEqual(result.lock, NO_FALLBACK_LOCK);
  assert.equal(result.transition, null);
});

test("resolveReviewVerdict: primary decisive (MERGE_OK) -> used directly even with fallbacks configured, no transition", async () => {
  const primary = new ScriptedReviewer("different-model-codex", "MERGE_OK");
  const fallback = new ScriptedReviewer("human", "MERGE_OK");
  const result = await resolveReviewVerdict({
    primary,
    fallbacks: [fallback],
    data: mkData(),
    triggerPin: TRIGGERED_LONG_AGO,
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock: NO_FALLBACK_LOCK,
  });
  assert.equal(result.sourceKind, "different-model-codex");
  assert.equal(result.transition, null);
});

test("resolveReviewVerdict: primary WAIT_REVIEW under the threshold -> still the primary's verdict, no switch yet", async () => {
  const primary = new ScriptedReviewer("different-model-codex", "WAIT_REVIEW");
  const fallback = new ScriptedReviewer("same-model-trusted", "MERGE_OK");
  const justTriggered = { head: HEAD, at: "2026-01-01T00:59:00Z" }; // 1 minute ago
  const result = await resolveReviewVerdict({
    primary,
    fallbacks: [fallback],
    data: mkData(),
    triggerPin: justTriggered,
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock: NO_FALLBACK_LOCK,
  });
  assert.equal(result.verdict.action, "WAIT_REVIEW");
  assert.equal(result.sourceKind, "different-model-codex");
  assert.equal(result.transition, null);
});

test("resolveReviewVerdict: threshold crossed -> the first fallback with a decisive verdict gates, using its OWN identity rules; a switch is reported and MERGE_OK gets locked", async () => {
  const primary = new ScriptedReviewer("different-model-codex", "WAIT_REVIEW");
  const fallback = new SameModelTrustedReviewer(["trusted-bot"]); // real mode semantics, not scripted
  const data = mkData({ reviews: [mkReview("trusted-bot", HEAD, "APPROVED")] });
  const result = await resolveReviewVerdict({
    primary,
    fallbacks: [fallback],
    data,
    triggerPin: TRIGGERED_LONG_AGO,
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock: NO_FALLBACK_LOCK,
  });
  assert.deepEqual(result.verdict, {
    action: "MERGE_OK",
    headOid: HEAD,
    generationResponded: false,
    coverageEstablished: false,
  });
  assert.equal(result.sourceKind, "same-model-trusted");
  assert.deepEqual(result.lock, { head: HEAD, kind: "same-model-trusted" });
  assert.deepEqual(result.transition, { kind: "switch", mode: "same-model-trusted", head: HEAD });
});

test("resolveReviewVerdict: threshold crossed but an UNTRUSTED approver doesn't satisfy the fallback's own identity rules -> still queues, no switch", async () => {
  const primary = new ScriptedReviewer("different-model-codex", "WAIT_REVIEW");
  const fallback = new SameModelTrustedReviewer(["trusted-bot"]);
  const data = mkData({ reviews: [mkReview("random-account", HEAD, "APPROVED")] }); // not trusted
  const result = await resolveReviewVerdict({
    primary,
    fallbacks: [fallback],
    data,
    triggerPin: TRIGGERED_LONG_AGO,
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock: NO_FALLBACK_LOCK,
  });
  assert.equal(result.verdict.action, "WAIT_REVIEW");
  assert.equal(result.sourceKind, "different-model-codex");
  assert.deepEqual(result.lock, NO_FALLBACK_LOCK);
  assert.equal(result.transition, null);
});

test("resolveReviewVerdict: ordered fallback list — the SECOND entry gates when the first isn't decisive yet", async () => {
  const primary = new ScriptedReviewer("different-model-codex", "WAIT_REVIEW");
  const trustedBot = new ScriptedReviewer("same-model-trusted", "WAIT_REVIEW"); // not decisive
  const human = new ScriptedReviewer("human", "MERGE_OK");
  const result = await resolveReviewVerdict({
    primary,
    fallbacks: [trustedBot, human],
    data: mkData(),
    triggerPin: TRIGGERED_LONG_AGO,
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock: NO_FALLBACK_LOCK,
  });
  assert.equal(result.sourceKind, "human");
  assert.deepEqual(result.transition, { kind: "switch", mode: "human", head: HEAD });
});

// ── #54 R2 lock semantics (post PR #71 review): the lock is ADVISORY — it survives primary
// non-decisiveness, never overrides fresh blocking signals, is re-verified against live data
// at every use, and is never cleared at verdict-resolution time. ──

test("resolveReviewVerdict R2: primary decisive HANDLE_THREADS gates (blocks) even with a lock on the current head — blocking signals outrank any lock (fable-review P1)", async () => {
  const lock: ReviewFallbackLock = { head: HEAD, kind: "same-model-trusted" };
  // HANDLE_THREADS can only arise from unresolved threads / a standing CHANGES_REQUESTED —
  // identity-unfiltered blocking signals (often a human's explicit block). The lock must not
  // resurrect MERGE_OK over them.
  const primary = new ScriptedReviewer("different-model-codex", "HANDLE_THREADS");
  const result = await resolveReviewVerdict({
    primary,
    fallbacks: [new SameModelTrustedReviewer(["trusted-bot"])],
    data: mkData(),
    triggerPin: TRIGGERED_LONG_AGO,
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock,
  });
  assert.equal(result.verdict.action, "HANDLE_THREADS"); // blocks — never MERGE_OK from the lock
  assert.equal(result.sourceKind, "different-model-codex");
  assert.deepEqual(result.transition, { kind: "revert", mode: "different-model-codex", head: HEAD });
  assert.deepEqual(result.lock, lock); // NOT cleared at resolution time (Codex PR #71 P2)
});

test("resolveReviewVerdict R2: primary decisive MERGE_OK with a lock held -> primary gates, revert reported, lock left in place (never cleared at resolution time)", async () => {
  const lock: ReviewFallbackLock = { head: HEAD, kind: "same-model-trusted" };
  const primary = new ScriptedReviewer("different-model-codex", "MERGE_OK");
  const result = await resolveReviewVerdict({
    primary,
    fallbacks: [new SameModelTrustedReviewer(["trusted-bot"])],
    data: mkData(),
    triggerPin: TRIGGERED_LONG_AGO,
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock,
  });
  assert.deepEqual(result.verdict, { action: "MERGE_OK", headOid: HEAD });
  assert.equal(result.sourceKind, "different-model-codex");
  assert.deepEqual(result.transition, { kind: "revert", mode: "different-model-codex", head: HEAD });
  assert.deepEqual(result.lock, lock); // survives — a transient non-merge tick must not lose the episode
});

test("resolveReviewVerdict R2: lock survives primary non-decisiveness — honored below the threshold by RE-VERIFYING the approval artifact on live data", async () => {
  const lock: ReviewFallbackLock = { head: HEAD, kind: "same-model-trusted" };
  const primary = new ScriptedReviewer("different-model-codex", "WAIT_REVIEW");
  const fallback = new SameModelTrustedReviewer(["trusted-bot"]);
  const data = mkData({ reviews: [mkReview("trusted-bot", HEAD, "APPROVED")] }); // artifact exists
  const justTriggered = { head: HEAD, at: "2026-01-01T00:59:00Z" }; // below threshold
  const result = await resolveReviewVerdict({
    primary,
    fallbacks: [fallback],
    data,
    triggerPin: justTriggered,
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock,
  });
  assert.deepEqual(result.verdict, {
    action: "MERGE_OK",
    headOid: HEAD,
    generationResponded: false,
    coverageEstablished: false,
  });
  assert.equal(result.sourceKind, "same-model-trusted");
  assert.deepEqual(result.lock, lock); // unchanged
});

test("resolveReviewVerdict R2: a FORGED lock (valid kind, but no matching approval on the PR) synthesizes nothing (fable-review P2)", async () => {
  const forged: ReviewFallbackLock = { head: HEAD, kind: "human" };
  const primary = new ScriptedReviewer("different-model-codex", "WAIT_REVIEW");
  const fallback = new HumanReviewer(); // real mode: needs a non-author APPROVED review
  const data = mkData(); // NO reviews at all — the claimed approval does not exist
  // Below the threshold the lock re-verify path runs; the artifact is missing -> queue.
  const below = await resolveReviewVerdict({
    primary,
    fallbacks: [fallback],
    data,
    triggerPin: { head: HEAD, at: "2026-01-01T00:59:00Z" },
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock: forged,
  });
  assert.equal(below.verdict.action, "WAIT_REVIEW");
  // Past the threshold the chain runs; the artifact is still missing -> still queue.
  const past = await resolveReviewVerdict({
    primary,
    fallbacks: [fallback],
    data,
    triggerPin: TRIGGERED_LONG_AGO,
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock: forged,
  });
  assert.equal(past.verdict.action, "WAIT_REVIEW");
});

test("resolveReviewVerdict R2: a lock whose kind is NOT among the currently configured fallbacks is ignored (config removal revokes the episode; a forged kind matches nothing)", async () => {
  const lock: ReviewFallbackLock = { head: HEAD, kind: "human" };
  const primary = new ScriptedReviewer("different-model-codex", "WAIT_REVIEW");
  const data = mkData({ reviews: [mkReview("alice", HEAD, "APPROVED")] }); // a human approval DOES exist
  const result = await resolveReviewVerdict({
    primary,
    fallbacks: [],
    data,
    triggerPin: { head: HEAD, at: "2026-01-01T00:59:00Z" },
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock, // fallback list emptied since the lock was recorded
  });
  assert.equal(result.verdict.action, "WAIT_REVIEW"); // fail-closed: no configured fallback, no failover
  assert.equal(result.transition, null);
});

test("resolveReviewVerdict R2: lock + fresh blocking signals in the data -> the fallback's own re-verify blocks; never MERGE_OK (fable-review P1, non-decisive-primary variant)", async () => {
  const lock: ReviewFallbackLock = { head: HEAD, kind: "same-model-trusted" };
  // A primary whose own query failed (REVIEW_UNAVAILABLE) while the live data now carries a
  // standing CHANGES_REQUESTED — the lock's re-verification runs the real mode, which puts
  // blocking signals first.
  const primary = new ScriptedReviewer("different-model-codex", "REVIEW_UNAVAILABLE");
  const fallback = new SameModelTrustedReviewer(["trusted-bot"]);
  const data = mkData({
    reviews: [
      mkReview("trusted-bot", HEAD, "APPROVED"), // the fallback approval still exists...
      mkReview("some-human", HEAD, "CHANGES_REQUESTED"), // ...but a human has since blocked
    ],
  });
  const below = await resolveReviewVerdict({
    primary,
    fallbacks: [fallback],
    data,
    triggerPin: { head: HEAD, at: "2026-01-01T00:59:00Z" },
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock,
  });
  assert.notEqual(below.verdict.action, "MERGE_OK"); // the lock never overrides the block
  const past = await resolveReviewVerdict({
    primary,
    fallbacks: [fallback],
    data,
    triggerPin: TRIGGERED_LONG_AGO,
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock,
  });
  assert.equal(past.verdict.action, "HANDLE_THREADS"); // the chain surfaces the block (gates HUMAN)
});

test("resolveReviewVerdict: a lock recorded for a DIFFERENT (older) head is stale and ignored — a new push re-derives from scratch", async () => {
  const staleLock: ReviewFallbackLock = { head: "OLD_HEAD", kind: "same-model-trusted" };
  const primary = new ScriptedReviewer("different-model-codex", "MERGE_OK"); // healthy for the NEW head
  const result = await resolveReviewVerdict({
    primary,
    fallbacks: [new SameModelTrustedReviewer(["trusted-bot"])],
    data: mkData({ headOid: HEAD }),
    triggerPin: TRIGGERED_LONG_AGO,
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock: staleLock,
  });
  assert.equal(result.sourceKind, "different-model-codex"); // primary gates the new head directly
  assert.equal(result.transition, null); // no active episode on this head to revert from
  // The stale row is inert here and cleared by driveOne's head-change branch (the only
  // resolution-path clear) — this pure function never clears.
  assert.deepEqual(result.lock, staleLock);
});

test("resolveReviewVerdict: no trigger pin recorded yet -> never past threshold, primary's verdict unchanged (fail-closed)", async () => {
  const primary = new ScriptedReviewer("different-model-codex", "WAIT_REVIEW");
  const fallback = new ScriptedReviewer("human", "MERGE_OK");
  const result = await resolveReviewVerdict({
    primary,
    fallbacks: [fallback],
    data: mkData(),
    triggerPin: { head: null, at: null },
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock: NO_FALLBACK_LOCK,
  });
  assert.equal(result.sourceKind, "different-model-codex");
  assert.equal(result.transition, null);
});

test("resolveReviewVerdict: REVIEW_UNAVAILABLE (an explicit failure) is treated the same as a persistent WAIT_REVIEW for failover purposes", async () => {
  const primary = new ScriptedReviewer("different-model-codex", "REVIEW_UNAVAILABLE");
  const fallback = new ScriptedReviewer("human", "MERGE_OK");
  const result = await resolveReviewVerdict({
    primary,
    fallbacks: [fallback],
    data: mkData(),
    triggerPin: TRIGGERED_LONG_AGO,
    now: NOW,
    failoverAfterSec: FAILOVER_AFTER_SEC,
    lock: NO_FALLBACK_LOCK,
  });
  assert.equal(result.sourceKind, "human");
  assert.deepEqual(result.transition, { kind: "switch", mode: "human", head: HEAD });
});

// ── #273 LIVE VERIFICATION (#278, 2026-07-19/21): the REAL bot's clean-comment format ────────
// Verbatim body of https://github.com/herehigher/sapwood/issues/278 comment 5015784046 — the
// live @codex review response to the #277-style trigger. Ground truth this parser must accept:
// flavor prose trails the canonical phrase ON THE SAME LINE; the OID line is the bot's NATIVE
// dialect (`**Reviewed commit:** `<10-hex-abbrev>``), NOT the trigger's requested custom label.
const LIVE_HEAD = "cdee61ce5c677a674e7cf85e08839f7ee53da444";
const LIVE_PIN = { head: LIVE_HEAD, at: "2026-07-19T12:50:38Z" };
const LIVE_CLEAN_BODY = [
  "Codex Review: Didn't find any major issues. Can't wait for the next one!",
  "",
  "**Reviewed commit:** `cdee61ce5c`",
  "",
  "<details> <summary>ℹ️ About Codex in GitHub</summary>",
  "<br/>",
  "",
  "[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you",
  "- Open a pull request for review",
  "- Mark a draft as ready",
  '- Comment "@codex review".',
  "",
  "If Codex has suggestions, it will comment; otherwise it will react with 👍.",
  "",
  "",
  "",
  "",
  'Codex can also answer questions or update the PR. Try commenting "@codex address that feedback".',
  "            ",
  "</details>",
].join("\n");

test("LIVE #278: the real Codex clean comment (native abbreviated Reviewed-commit line) satisfies gate② on the matching head", () => {
  const data = mkData({
    headOid: LIVE_HEAD,
    comments: [{ login: "chatgpt-codex-connector[bot]", createdAt: "2026-07-19T12:52:03Z", body: LIVE_CLEAN_BODY }],
  });
  assert.deepEqual(new CodexReviewer().verdictFromData(data, LIVE_PIN), {
    action: "MERGE_OK",
    headOid: LIVE_HEAD,
    generationResponded: true,
    coverageEstablished: true,
  });
});

test("LIVE #278: the same real comment against a DIFFERENT head is discarded (abbreviated OID prefix-mismatch)", () => {
  const other = "3171aae349f00000000000000000000000000000";
  const data = mkData({
    headOid: other,
    comments: [{ login: "chatgpt-codex-connector[bot]", createdAt: "2026-07-19T12:52:03Z", body: LIVE_CLEAN_BODY }],
  });
  assert.equal(new CodexReviewer().verdictFromData(data, { head: other, at: "2026-07-19T12:50:38Z" }).action, "WAIT_REVIEW");
});

test("LIVE #278: native line plus an echoed full-OID line (both matching) is accepted — multiple agreeing assertions", () => {
  const body = `${LIVE_CLEAN_BODY}\nReviewed head OID: ${LIVE_HEAD}`;
  const data = mkData({
    headOid: LIVE_HEAD,
    comments: [{ login: "chatgpt-codex-connector[bot]", createdAt: "2026-07-19T12:52:03Z", body }],
  });
  assert.equal(new CodexReviewer().verdictFromData(data, LIVE_PIN).action, "MERGE_OK");
});

test("#273 abbreviation floor: a hex prefix shorter than 7 chars never matches; non-hex never prefix-matches", () => {
  assert.equal(oidAssertionMatchesHead("cdee61", LIVE_HEAD), false);
  assert.equal(oidAssertionMatchesHead("cdee61c", LIVE_HEAD), true);
  assert.equal(oidAssertionMatchesHead("cdee61ce5c", LIVE_HEAD), true);
  assert.equal(oidAssertionMatchesHead(LIVE_HEAD, LIVE_HEAD), true);
  assert.equal(oidAssertionMatchesHead("HEAD", "HEADLONGER"), false);
  assert.equal(oidAssertionMatchesHead("HEAD", "HEAD"), true);
});

test("#273 live format: bold label + backticked value decorations are stripped by the assertion regex", () => {
  const data = mkData({
    headOid: LIVE_HEAD,
    comments: [
      {
        login: "chatgpt-codex-connector[bot]",
        createdAt: "2026-07-19T12:52:03Z",
        body: "Codex Review: Didn't find any major issues.\n**Reviewed commit:** `cdee61ce5c`",
      },
    ],
  });
  assert.equal(new CodexReviewer().verdictFromData(data, LIVE_PIN).action, "MERGE_OK");
});

test("#273 anchored phrase: trailing flavor prose is accepted, mid-prose embedding still is not", () => {
  const good = mkData({
    headOid: LIVE_HEAD,
    comments: [
      {
        login: "chatgpt-codex-connector[bot]",
        createdAt: "2026-07-19T12:52:03Z",
        body: "Codex Review: Didn't find any major issues. More of your lovely PRs please.\n**Reviewed commit:** `cdee61ce5c`",
      },
    ],
  });
  assert.equal(new CodexReviewer().verdictFromData(good, LIVE_PIN).action, "MERGE_OK");
  const bad = mkData({
    headOid: LIVE_HEAD,
    comments: [
      {
        login: "chatgpt-codex-connector[bot]",
        createdAt: "2026-07-19T12:52:03Z",
        body: `My honest take is that saying "Codex Review: Didn't find any major issues" would be wrong.\n**Reviewed commit:** \`cdee61ce5c\``,
      },
    ],
  });
  assert.equal(new CodexReviewer().verdictFromData(bad, LIVE_PIN).action, "WAIT_REVIEW");
});

// ── #282 (M10, E1): ReviewerAdapter seam — first-class approval/blocking split ──────────────────
// Design #279 §1. This section tests the NEW seam types/functions directly, then regression-pins
// them against the UNCHANGED verdictFromData surface over a shared fixture corpus — the seam is
// a mechanical reorganization of the same computation `verdictFrom` already performed, never a
// new one (#282 AC: "no new behavior").

// -- Finding / validated findings shape (ApprovalResult's `rejected` variant) --

test("isFinding: accepts a well-formed finding, rejects malformed/partial shapes", () => {
  assert.equal(isFinding({ id: "1", body: "explain the bug" }), true);
  assert.equal(isFinding({ id: "", body: "x" }), false); // empty id
  assert.equal(isFinding({ id: "1", body: "" }), false); // empty body
  assert.equal(isFinding({ id: "1" }), false); // missing body
  assert.equal(isFinding({ body: "x" }), false); // missing id
  assert.equal(isFinding(null), false);
  assert.equal(isFinding("finding"), false);
  assert.equal(isFinding(42), false);
});

test("validateFindings: an empty array is valid (approved carries zero findings, never `rejected` with nothing to say); one bad element fails the WHOLE array (fail-closed)", () => {
  assert.equal(validateFindings([]), true);
  assert.equal(
    validateFindings([
      { id: "1", body: "a" },
      { id: "2", body: "b" },
    ]),
    true,
  );
  assert.equal(
    validateFindings([
      { id: "1", body: "a" },
      { id: "", body: "b" },
    ]),
    false,
  );
  assert.equal(validateFindings("not-an-array"), false);
  assert.equal(validateFindings(null), false);
});

test("ApprovalResult: `rejected` carries a validated, NON-EMPTY findings array from day one (#282 AC); `approved` cannot even represent findings — both encoded in the TYPE (#282 review round 2, adopted P2), not just a runtime check", () => {
  const findings: [Finding, ...Finding[]] = [{ id: "1", body: "missing null check" }];
  assert.equal(validateFindings(findings), true);
  const rejected: ApprovalResult = { kind: "rejected", headOid: "HEAD", findings };
  assert.equal(rejected.kind, "rejected");
  assert.ok(rejected.findings.length >= 1); // the tuple type [Finding, ...Finding[]] guarantees this at compile time too
  assert.deepEqual(rejected.findings, findings);

  const approved: ApprovalResult = { kind: "approved", headOid: "HEAD", evidence: { freshApprovingReviews: 1, freshTrustedSignals: 0 } };
  assert.equal(approved.kind, "approved");
  if (approved.kind === "approved") {
    // `findings?: never` on the approved variant — this is the ONLY value the type permits.
    assert.equal(approved.findings, undefined);
  }
  // NOTE (#282 review round 2, adopted P2): `{ kind: "rejected", findings: [] }` and
  // `{ kind: "approved", ..., findings: [...] }` both fail to COMPILE against the ApprovalResult
  // type above (findings: [Finding, ...Finding[]] rejects an empty array; findings?: never on
  // `approved` rejects any real array) — manually verified via a temporary probe file under
  // engine/src/roles/ (a location `tsc --noEmit` actually checks) before this fix was pushed, not
  // committed here as a `@ts-expect-error` assertion: engine/tsconfig.json excludes `*.test.ts`
  // from `tsc --noEmit`, and `npm test` runs this file through tsx (transpile-only, no type
  // diagnostics), so a `@ts-expect-error` directive INSIDE this file would be inert — never
  // actually re-checked by CI — which would be misleading to leave here as if it were live
  // protection. The runtime assertions above are what this test suite can actually enforce on
  // every run; the type itself is the real, CI-visible guard for any checked `.ts` caller.
});

// -- deriveBlockingSignal: the ONE shared pure blocking function every kind routes through --

test("deriveBlockingSignal: no unresolved threads, no standing change request -> not blocked", () => {
  assert.deepEqual(deriveBlockingSignal(mkData()), {
    blocked: false,
    unresolvedThreads: 0,
    changesRequestedOnHead: false,
    adjudicatedDuplicates: 0,
  });
});

// ── #378 (F14): resolved-thread + head-freshness awareness ──────────────────────────────────
// Reference case: PR #366, dogfood run 2026-07-24. The same config-YAML finding was raised FIVE
// times across re-reviews — twice against a stale head — after it had been human-adjudicated,
// thread-resolved, and its remedy merged elsewhere (PR #367). Each re-flag re-entered the
// FIXABLE gate and consumed a fix-round evaluation, contributing to the lane hitting prFixCap
// and gatedReentryCap.

const FINDING = "missing required key `foo`";

const mkThread = (over: Partial<ReviewThreadSpan> & { id: string }): ReviewThreadSpan => ({
  isResolved: false,
  isOutdated: false,
  path: "sapwood.config.yaml",
  line: 12,
  originalLine: 12,
  findingDigest: findingDigest(FINDING),
  anchorCommitOid: "ANCHOR",
  ...over,
});

test("#378 (PR #445 review): a DIFFERENT finding on an already-adjudicated span is NOT a duplicate", () => {
  // The span-collision defect: round 1 adjudicates "missing required key `foo`" on
  // sapwood.config.yaml:12 and resolves it; round 2 raises "wrong indentation" as a brand-new
  // thread on that same, still-current line. Keying on file:line alone would misclassify the
  // second — a real, never-adjudicated finding — as a duplicate and drop it from gate② input.
  const data = mkData({
    unresolvedThreads: 1,
    threads: [
      mkThread({ id: "T_ADJUDICATED", isResolved: true }),
      mkThread({ id: "T_DIFFERENT_FINDING", findingDigest: findingDigest("wrong indentation") }),
    ],
  });
  assert.deepEqual(adjudicatedDuplicateThreads(data), []);
  assert.equal(deriveBlockingSignal(data).unresolvedThreads, 1);
  assert.equal(deriveBlockingSignal(data).blocked, true);
  assert.equal(new CodexReviewer().verdictFromData(data).action, "HANDLE_THREADS");
});

test("#378: the SAME finding at a DIFFERENT span is not a duplicate either — both halves of the key are load-bearing", () => {
  const data = mkData({
    unresolvedThreads: 1,
    threads: [mkThread({ id: "T_OLD", isResolved: true }), mkThread({ id: "T_ELSEWHERE", line: 88, originalLine: 88 })],
  });
  assert.deepEqual(adjudicatedDuplicateThreads(data), []);
  assert.equal(deriveBlockingSignal(data).blocked, true);
});

test("#378: a thread with NO readable finding body is unkeyable and never filtered, in either role", () => {
  const data = mkData({
    unresolvedThreads: 1,
    threads: [mkThread({ id: "T_OLD", isResolved: true, findingDigest: null }), mkThread({ id: "T_NEW", findingDigest: null })],
  });
  assert.deepEqual(adjudicatedDuplicateThreads(data), []);
  assert.equal(deriveBlockingSignal(data).blocked, true);
});

test("#378: a re-raised finding on a RESOLVED, unchanged span is filtered out of gate② input", () => {
  // The PR #366 shape: T_OLD was adjudicated and resolved; T_NEW is the same finding re-raised
  // on the same file:line as a BRAND-NEW thread. Matching on thread id would never catch this —
  // that is exactly why the loop kept paying for it.
  const data = mkData({
    unresolvedThreads: 1,
    threads: [mkThread({ id: "T_OLD", isResolved: true }), mkThread({ id: "T_NEW" })],
  });
  assert.deepEqual(
    adjudicatedDuplicateThreads(data).map((t) => t.id),
    ["T_NEW"],
  );
  const signal = deriveBlockingSignal(data);
  assert.equal(signal.unresolvedThreads, 0);
  assert.equal(signal.adjudicatedDuplicates, 1);
  assert.equal(signal.blocked, false); // no fix round consumed
  assert.equal(new CodexReviewer().verdictFromData(data).action, "WAIT_REVIEW"); // not HANDLE_THREADS
});

test("#378 regression guard: an unresolved thread with NO prior adjudication on its span still blocks", () => {
  const data = mkData({
    unresolvedThreads: 1,
    threads: [
      mkThread({ id: "T_OLD", isResolved: true, line: 12, originalLine: 12 }),
      mkThread({ id: "T_NEW", line: 99, originalLine: 99 }),
    ],
  });
  assert.deepEqual(adjudicatedDuplicateThreads(data), []);
  assert.equal(deriveBlockingSignal(data).blocked, true);
  assert.equal(new CodexReviewer().verdictFromData(data).action, "HANDLE_THREADS");
});

test("#378 regression guard: a resolved thread whose span CHANGED after resolution (isOutdated) does not adjudicate anything", () => {
  // GitHub marks a thread outdated the moment its diff position stops existing in the current
  // diff — i.e. the code it was adjudicated against moved. The re-raise is then genuinely fresh.
  const data = mkData({
    unresolvedThreads: 1,
    threads: [mkThread({ id: "T_OLD", isResolved: true, isOutdated: true, line: null }), mkThread({ id: "T_NEW" })],
  });
  assert.deepEqual(adjudicatedDuplicateThreads(data), []);
  assert.equal(deriveBlockingSignal(data).blocked, true);
  assert.equal(deriveBlockingSignal(data).unresolvedThreads, 1);
});

test("#378: an unresolved thread that is ITSELF outdated is never filtered (its span moved too)", () => {
  const data = mkData({
    unresolvedThreads: 1,
    threads: [mkThread({ id: "T_OLD", isResolved: true }), mkThread({ id: "T_NEW", isOutdated: true })],
  });
  assert.deepEqual(adjudicatedDuplicateThreads(data), []);
  assert.equal(deriveBlockingSignal(data).blocked, true);
});

test("#378: a file-level thread (no keyable span) is never filtered, in either role", () => {
  const data = mkData({
    unresolvedThreads: 1,
    threads: [
      mkThread({ id: "T_OLD", isResolved: true, path: null, line: null, originalLine: null }),
      mkThread({ id: "T_NEW", path: null, line: null, originalLine: null }),
    ],
  });
  assert.deepEqual(adjudicatedDuplicateThreads(data), []);
  assert.equal(deriveBlockingSignal(data).blocked, true);
});

test("#378: absent thread data (every pre-#378 fixture / forge fake) filters nothing — exact pre-#378 gating", () => {
  const data = mkData({ unresolvedThreads: 2 });
  assert.equal(data.threads, undefined);
  assert.deepEqual(adjudicatedDuplicateThreads(data), []);
  assert.equal(deriveBlockingSignal(data).unresolvedThreads, 2);
  assert.equal(deriveBlockingSignal(data).blocked, true);
});

test("#378: the filter never drives the count below zero when `threads` is a partial view of the paged total", () => {
  // unresolvedThreads is the authoritative paged total; `threads` can be short of it if the
  // 50-page ceiling cut the fetch. Subtracting must not underflow into a negative count.
  const data = mkData({
    unresolvedThreads: 1,
    threads: [mkThread({ id: "A", isResolved: true }), mkThread({ id: "B" }), mkThread({ id: "C" })],
  });
  assert.equal(adjudicatedDuplicateThreads(data).length, 2);
  assert.equal(deriveBlockingSignal(data).unresolvedThreads, 0);
});

test("#378: a standing CHANGES_REQUESTED still blocks even when every thread is an adjudicated duplicate", () => {
  const data = mkData({
    unresolvedThreads: 1,
    threads: [mkThread({ id: "T_OLD", isResolved: true }), mkThread({ id: "T_NEW" })],
    reviews: [mkReview("some-human", "HEAD", "CHANGES_REQUESTED")],
  });
  const signal = deriveBlockingSignal(data);
  assert.equal(signal.unresolvedThreads, 0);
  assert.equal(signal.blocked, true); // the OTHER always-blocking signal is untouched
});

// -- staleHeadReviewCount: a review of a non-current head is advisory, never gate input --

test("#378: a review on a stale head counts toward NEITHER the approval signal nor the blocking one", () => {
  const data = mkData({
    reviews: [
      mkReview("chatgpt-codex-connector[bot]", "OLD_HEAD", "COMMENTED"), // would have approved
      mkReview("some-human", "OLD_HEAD", "CHANGES_REQUESTED"), // would have blocked
    ],
  });
  assert.equal(staleHeadReviewCount(data.reviews, data.headOid), 2);
  assert.equal(freshHeadReviewCount(data.reviews, data.headOid, data.author, ["COMMENTED", "APPROVED"]), 0);
  assert.equal(deriveBlockingSignal(data).changesRequestedOnHead, false);
  assert.equal(deriveBlockingSignal(data).blocked, false);
  // Excluded from the ACTION entirely: neither MERGE_OK nor HANDLE_THREADS — nothing decisive.
  assert.equal(new CodexReviewer().verdictFromData(data).action, "WAIT_REVIEW");
});

test("#378: the SAME reviews on the CURRENT head are gate input again — the exclusion is head-bound, not identity-bound", () => {
  const data = mkData({ reviews: [mkReview("some-human", "HEAD", "CHANGES_REQUESTED")] });
  assert.equal(staleHeadReviewCount(data.reviews, data.headOid), 0);
  assert.equal(deriveBlockingSignal(data).blocked, true);
});

test("deriveBlockingSignal: unresolved threads alone block", () => {
  const signal = deriveBlockingSignal(mkData({ unresolvedThreads: 3 }));
  assert.equal(signal.blocked, true);
  assert.equal(signal.unresolvedThreads, 3);
  assert.equal(signal.changesRequestedOnHead, false);
});

test("deriveBlockingSignal: a standing CHANGES_REQUESTED alone blocks", () => {
  const data = mkData({ reviews: [mkReview("some-human", "HEAD", "CHANGES_REQUESTED")] });
  const signal = deriveBlockingSignal(data);
  assert.equal(signal.blocked, true);
  assert.equal(signal.changesRequestedOnHead, true);
});

test("deriveBlockingSignal: agrees with changesRequestedOnHead's own per-author clear semantics (same underlying computation, not re-derived ad hoc)", () => {
  const data = mkData({
    reviews: [mkReview("alice", "HEAD", "CHANGES_REQUESTED"), mkReview("alice", "HEAD", "APPROVED")],
  });
  assert.equal(deriveBlockingSignal(data).changesRequestedOnHead, changesRequestedOnHead(data.reviews, data.headOid, data.author));
  assert.equal(deriveBlockingSignal(data).blocked, false); // same-reviewer re-approval clears it
});

// -- ReviewerAdapter.trigger / evaluate: each existing kind implements the seam too --

test("CodexReviewer implements ReviewerAdapter: trigger() delegates to triggerReview (same comment, same call)", async () => {
  const calls: [number, string][] = [];
  const forge = {
    getIssueBody: async () => "## Verification\nrun tests",
    addPRComment: async (pr: number, body: string) => {
      calls.push([pr, body]);
    },
  } as unknown as IForge;
  const reviewer: ReviewerAdapter = new CodexReviewer();
  await reviewer.trigger({ forge, pr: 7, issue: 46 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], 7);
  assert.match(calls[0]![1], /@codex review/);
});

test("CodexReviewer.evaluate: no PRReviewData supplied -> unavailable (never silently pending)", async () => {
  const reviewer: ReviewerAdapter = new CodexReviewer();
  const result = await reviewer.evaluate({ forge: {} as IForge, pr: 1, issue: 1 });
  assert.deepEqual(result, { kind: "unavailable", headOid: null, reason: "no PRReviewData supplied to evaluate()" });
});

test("CodexReviewer.evaluate: a fresh Codex-bot COMMENTED review -> approved, with evidence counts — blocking-blind (no thread/CR fields consulted at all)", async () => {
  const reviewer: ReviewerAdapter = new CodexReviewer();
  const data = mkData({ reviews: [mkReview("chatgpt-codex-connector[bot]", "HEAD", "COMMENTED")] });
  const result = await reviewer.evaluate({ forge: {} as IForge, pr: 1, issue: 1, data });
  assert.deepEqual(result, {
    kind: "approved",
    headOid: "HEAD",
    evidence: { freshApprovingReviews: 1, freshTrustedSignals: 0 },
  });
});

test("CodexReviewer.evaluate: nothing yet -> pending", async () => {
  const reviewer: ReviewerAdapter = new CodexReviewer();
  const result = await reviewer.evaluate({ forge: {} as IForge, pr: 1, issue: 1, data: mkData() });
  assert.deepEqual(result, { kind: "pending", headOid: "HEAD" });
});

test("HumanReviewer.evaluate: an APPROVED non-author review -> approved; a COMMENTED review does not count", async () => {
  const reviewer: ReviewerAdapter = new HumanReviewer();
  const approved = await reviewer.evaluate({
    forge: {} as IForge,
    pr: 1,
    issue: 1,
    data: mkData({ reviews: [mkReview("alice", "HEAD", "APPROVED")] }),
  });
  assert.equal(approved.kind, "approved");
  const commented = await reviewer.evaluate({
    forge: {} as IForge,
    pr: 1,
    issue: 1,
    data: mkData({ reviews: [mkReview("alice", "HEAD", "COMMENTED")] }),
  });
  assert.equal(commented.kind, "pending");
});

test("SameModelTrustedReviewer.evaluate: an empty trustedLogins list can NEVER produce approved (fail-closed, mirrors verdictFromData)", async () => {
  const reviewer: ReviewerAdapter = new SameModelTrustedReviewer([]);
  const result = await reviewer.evaluate({
    forge: {} as IForge,
    pr: 1,
    issue: 1,
    data: mkData({ reviews: [mkReview("anyone", "HEAD", "APPROVED")] }),
  });
  assert.equal(result.kind, "pending");
});

test("SameModelTrustedReviewer.evaluate: only a NAMED trusted login's APPROVED review counts", async () => {
  const reviewer: ReviewerAdapter = new SameModelTrustedReviewer(["trusted-bot"]);
  const untrusted = await reviewer.evaluate({
    forge: {} as IForge,
    pr: 1,
    issue: 1,
    data: mkData({ reviews: [mkReview("random-account", "HEAD", "APPROVED")] }),
  });
  assert.equal(untrusted.kind, "pending");
  const trusted = await reviewer.evaluate({
    forge: {} as IForge,
    pr: 1,
    issue: 1,
    data: mkData({ reviews: [mkReview("trusted-bot", "HEAD", "APPROVED")] }),
  });
  assert.equal(trusted.kind, "approved");
});

// -- buildReviewerByKind: exhaustive, no fall-through-to-Codex (#282 AC) --

test("buildReviewerByKind: every REVIEWER_KINDS entry constructs a reviewer of its OWN kind (never silently a CodexReviewer)", () => {
  for (const kind of REVIEWER_KINDS) {
    const reviewer = buildReviewerByKind(kind, []);
    assert.equal(reviewer.kind, kind);
  }
});

test("buildReviewerByKind: an unrecognized kind (bypassing the type system) throws rather than silently building a CodexReviewer (#282 startup fail-safe)", () => {
  assert.throws(
    () => buildReviewerByKind("bogus-kind" as unknown as Parameters<typeof buildReviewerByKind>[0], []),
    /unhandled reviewer kind/,
  );
});

test("grep-invariant: buildReviewerByKind's function body contains no `default:` switch case (#282 exhaustiveness AC)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "reviewer.ts"), "utf8");
  const sigIdx = source.indexOf("export function buildReviewerByKind(");
  assert.ok(sigIdx >= 0, "buildReviewerByKind not found in reviewer.ts");
  const openIdx = source.indexOf("{", source.indexOf("): Reviewer", sigIdx));
  assert.ok(openIdx > sigIdx, "could not find buildReviewerByKind's opening brace");
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  assert.ok(closeIdx > openIdx, "could not find buildReviewerByKind's closing brace");
  const body = source.slice(openIdx, closeIdx + 1);
  assert.doesNotMatch(body, /\bdefault\s*:/, "buildReviewerByKind must never fall through to a default: case (#282)");
});

// -- Regression pin: verdictFromData (unchanged surface) vs evaluate()+deriveBlockingSignal (new
// seam) must derive the IDENTICAL ReviewAction over a shared fixture corpus, for all three kinds
// (#282 AC: "existing three kinds regression-pinned"). --

async function reconstructAction(adapter: ReviewerAdapter, data: PRReviewData, pin?: ReviewTriggerPin): Promise<ReviewAction> {
  const blocking = deriveBlockingSignal(data);
  if (blocking.blocked) return "HANDLE_THREADS";
  const ctx: ReviewContext =
    pin === undefined ? { forge: {} as IForge, pr: 0, issue: 0, data } : { forge: {} as IForge, pr: 0, issue: 0, data, pin };
  const approval = await adapter.evaluate(ctx);
  if (approval.kind === "approved") return "MERGE_OK";
  if (approval.kind === "rejected") return "HANDLE_THREADS";
  if (approval.kind === "unavailable") return "REVIEW_UNAVAILABLE";
  return "WAIT_REVIEW";
}

function corpusFor(approverLogin: string, acceptState: string): { label: string; data: PRReviewData; pin?: ReviewTriggerPin }[] {
  return [
    { label: "no signals at all", data: mkData(), pin: PIN },
    { label: "fresh approving review only", data: mkData({ reviews: [mkReview(approverLogin, "HEAD", acceptState)] }), pin: PIN },
    { label: "unresolved threads only (blocks despite no approval)", data: mkData({ unresolvedThreads: 2 }), pin: PIN },
    {
      label: "a standing CHANGES_REQUESTED only (blocks)",
      data: mkData({ reviews: [mkReview("some-human", "HEAD", "CHANGES_REQUESTED")] }),
      pin: PIN,
    },
    {
      label: "approving review AND unresolved threads (blocking wins over approval)",
      data: mkData({ reviews: [mkReview(approverLogin, "HEAD", acceptState)], unresolvedThreads: 1 }),
      pin: PIN,
    },
    {
      label: "approving review AND a standing change request from someone else (blocking wins)",
      data: mkData({
        reviews: [mkReview(approverLogin, "HEAD", acceptState), mkReview("some-human", "HEAD", "CHANGES_REQUESTED")],
      }),
      pin: PIN,
    },
    {
      label: "a stale review on an OLD head does not count",
      data: mkData({ reviews: [mkReview(approverLogin, "OLD_HEAD", acceptState)] }),
      pin: PIN,
    },
    {
      label: "the PR author's own review never counts",
      data: mkData({ reviews: [mkReview("producer", "HEAD", acceptState)] }),
      pin: PIN,
    },
    {
      label: "no trigger pin supplied at all",
      data: mkData({ reviews: [mkReview(approverLogin, "HEAD", acceptState)] }),
    },
    {
      label: "an OID-bound trusted clean comment (#273) — no formal review at all",
      data: mkData({
        comments: [
          {
            login: approverLogin,
            createdAt: "2026-07-07T08:00:00Z",
            body: "Codex Review: Didn't find any major issues.\nReviewed head OID: HEAD",
          },
        ],
      }),
      pin: PIN,
    },
  ];
}

test("regression pin (#282): CodexReviewer — evaluate()+deriveBlockingSignal reconstructs the EXACT verdictFromData action over the fixture corpus", async () => {
  const reviewer = new CodexReviewer();
  for (const { label, data, pin } of corpusFor("chatgpt-codex-connector", "COMMENTED")) {
    const expected = reviewer.verdictFromData(data, pin).action;
    const actual = await reconstructAction(reviewer, data, pin);
    assert.equal(actual, expected, label);
  }
});

test("regression pin (#282): HumanReviewer — evaluate()+deriveBlockingSignal reconstructs the EXACT verdictFromData action over the fixture corpus", async () => {
  const reviewer = new HumanReviewer();
  for (const { label, data, pin } of corpusFor("alice", "APPROVED")) {
    const expected = reviewer.verdictFromData(data, pin).action;
    const actual = await reconstructAction(reviewer, data, pin);
    assert.equal(actual, expected, label);
  }
});

test("regression pin (#282): SameModelTrustedReviewer — evaluate()+deriveBlockingSignal reconstructs the EXACT verdictFromData action over the fixture corpus", async () => {
  const reviewer = new SameModelTrustedReviewer(["trusted-bot"]);
  for (const { label, data, pin } of corpusFor("trusted-bot", "APPROVED")) {
    const expected = reviewer.verdictFromData(data, pin).action;
    const actual = await reconstructAction(reviewer, data, pin);
    assert.equal(actual, expected, label);
  }
});

test("regression pin (#282): SameModelTrustedReviewer with an EMPTY trustedLogins list — both surfaces agree it can never approve (non-blocking scenarios only)", async () => {
  const reviewer = new SameModelTrustedReviewer([]);
  const scenarios: { label: string; data: PRReviewData; pin?: ReviewTriggerPin }[] = [
    { label: "no signals", data: mkData(), pin: PIN },
    { label: "an untrusted APPROVED review", data: mkData({ reviews: [mkReview("random-account", "HEAD", "APPROVED")] }), pin: PIN },
  ];
  for (const { label, data, pin } of scenarios) {
    const expected = reviewer.verdictFromData(data, pin).action;
    const actual = await reconstructAction(reviewer, data, pin);
    assert.equal(actual, expected, label);
  }
  // Documented PRE-EXISTING quirk (unchanged by #282, not introduced by it): verdictFromData's
  // own empty-trustedLogins branch short-circuits to WAIT_REVIEW UNCONDITIONALLY, even when a
  // genuine blocking signal (unresolved threads / a standing change request) is present in the
  // live data — see SameModelTrustedReviewer.verdictFromData's own early return above. This
  // test's reconstructAction helper (like the design's real drive-loop combinator would) checks
  // deriveBlockingSignal FIRST, so the two surfaces intentionally diverge in exactly this corner
  // — a pre-existing quirk of the empty-allowlist fail-closed branch, out of scope to change here
  // (verdicts must stay byte-preserved, #282 AC).
  const blockedData = mkData({ unresolvedThreads: 1 });
  assert.equal(reviewer.verdictFromData(blockedData, PIN).action, "WAIT_REVIEW");
  assert.equal(await reconstructAction(reviewer, blockedData, PIN), "HANDLE_THREADS");
});
