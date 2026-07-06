// reviewer.ts tests: pure signal derivation (freshThumbCount, freshHeadReviewCount,
// deriveReviewAction) + the pluggable Reviewer implementations' verdictFromData (pure) and
// triggerReview (against a fake IForge — no real gh calls anywhere in this file).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  freshThumbCount,
  freshHeadReviewCount,
  changesRequestedOnHead,
  deriveReviewAction,
  normalizeLogin,
  CodexReviewer,
  HumanReviewer,
  SameModelTrustedReviewer,
  makeReviewer,
} from "./reviewer.js";
import { ConfigSchema } from "./config.js";
import type { IForge, PRReview, PRReviewData } from "./forge.js";
import type { Reviewer } from "./reviewer.js";

// ── pure signal helpers (0day pr_gate.sh parity) ──────────────────────────────────────────

test("freshThumbCount: only reactions created AFTER the cutoff count (0day #92 staleness)", () => {
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

const mkReview = (author: string, commitOid: string, state: string): PRReview => ({ author, commitOid, state });

test("freshHeadReviewCount: only non-author reviews on the CURRENT head, in an accepted state, count (0day #101)", () => {
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
    deriveReviewAction({ hasEyesReaction: false, freshApprovingReviews: 1, unresolvedThreads: 2, changesRequestedOnHead: false }),
    "HANDLE_THREADS",
  );
});

test("deriveReviewAction: a standing change request outranks a fresh approving review (Codex PR #42 P1)", () => {
  assert.equal(
    deriveReviewAction({ hasEyesReaction: false, freshApprovingReviews: 1, unresolvedThreads: 0, changesRequestedOnHead: true }),
    "HANDLE_THREADS",
  );
});

test("deriveReviewAction: a fresh approving review with no threads -> MERGE_OK", () => {
  assert.equal(
    deriveReviewAction({ hasEyesReaction: false, freshApprovingReviews: 1, unresolvedThreads: 0, changesRequestedOnHead: false }),
    "MERGE_OK",
  );
});

test("deriveReviewAction: nothing yet (no review, no eyes) -> WAIT_REVIEW, never a silent MERGE_OK", () => {
  assert.equal(
    deriveReviewAction({ hasEyesReaction: false, freshApprovingReviews: 0, unresolvedThreads: 0, changesRequestedOnHead: false }),
    "WAIT_REVIEW",
  );
  assert.equal(
    deriveReviewAction({ hasEyesReaction: true, freshApprovingReviews: 0, unresolvedThreads: 0, changesRequestedOnHead: false }),
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
  const reviews = [
    mkReview("rev", "HEAD", "CHANGES_REQUESTED"),
    mkReview("rev", "HEAD", "COMMENTED"),
  ];
  assert.equal(changesRequestedOnHead(reviews, "HEAD", "author"), true);
});

test("changesRequestedOnHead: a change request on an OLD head does not block the current head", () => {
  assert.equal(changesRequestedOnHead([mkReview("rev", "OLD", "CHANGES_REQUESTED")], "HEAD", "author"), false);
});

test("changesRequestedOnHead: a DISMISSED review never blocks (state is DISMISSED, not CHANGES_REQUESTED)", () => {
  assert.equal(changesRequestedOnHead([mkReview("rev", "HEAD", "DISMISSED")], "HEAD", "author"), false);
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
  assert.deepEqual(r.verdictFromData(data), { action: "MERGE_OK", headOid: "HEAD" });
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
    reviews: [
      mkReview("chatgpt-codex-connector", "HEAD", "APPROVED"),
      mkReview("random-account", "HEAD", "CHANGES_REQUESTED"),
    ],
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

test("CodexReviewer: triggerReview posts a plain `@codex review` PR comment (never a merge/approve call)", async () => {
  const calls: Array<[number, string]> = [];
  const forge = { addPRComment: async (pr: number, body: string) => void calls.push([pr, body]) } as unknown as IForge;
  await new CodexReviewer().triggerReview(forge, 42);
  assert.deepEqual(calls, [[42, "@codex review"]]);
});

test("HumanReviewer: only an explicit APPROVED state counts — a mere COMMENTED does not", () => {
  const r = new HumanReviewer();
  assert.equal(r.verdictFromData(mkData({ reviews: [mkReview("alice", "HEAD", "COMMENTED")] })).action, "WAIT_REVIEW");
  assert.equal(r.verdictFromData(mkData({ reviews: [mkReview("alice", "HEAD", "APPROVED")] })).action, "MERGE_OK");
});

test("HumanReviewer: triggerReview is a no-op (nothing to ping)", async () => {
  let called = false;
  const forge = { addPRComment: async () => { called = true; } } as unknown as IForge;
  const r: Reviewer = new HumanReviewer();
  await r.triggerReview(forge, 1);
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

test("makeReviewer: selects the configured reviewer kind, defaulting to Codex", () => {
  const codex = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 } });
  assert.ok(makeReviewer(codex) instanceof CodexReviewer);

  const human = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 }, reviewer: { mode: "human" } });
  assert.ok(makeReviewer(human) instanceof HumanReviewer);

  const trusted = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    reviewer: { mode: "same-model-trusted", trustedReviewers: ["bot"] },
  });
  assert.ok(makeReviewer(trusted) instanceof SameModelTrustedReviewer);
});
