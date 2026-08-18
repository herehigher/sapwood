// cap-split.test.ts (#965): unit coverage for the shared marker vocabulary conductor.ts and
// decompose.ts both read/write at the resume-cap -> engine `split` seam.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINE_COMMENT_MARKER } from "../forge/forge.js";
import {
  type CapSplitWipPointer,
  findCapSplitWipPointer,
  renderCapSplitWipComment,
  summarizeUnifiedDiffStat,
  wasCapSplitByState,
} from "./cap-split.js";

const ACTOR = "sapwood-bot";
// The real GithubForge.addIssueComment centrally stamps EVERY engine comment with
// ENGINE_COMMENT_MARKER (forge.ts) — fixtures below reproduce that stamp explicitly rather than
// relying on renderCapSplitWipComment to add it, since the marker is a WRITE-BOUNDARY guarantee
// from a different module, not something this comment's own render owns.
const engineComment = (login: string, body: string) => ({ login, body: `${body}\n\n${ENGINE_COMMENT_MARKER}` });

test("renderCapSplitWipComment + findCapSplitWipPointer round-trip every field, for a comment from the resolved engine actor", () => {
  const pointer: CapSplitWipPointer = {
    issue: 42,
    pr: 7,
    branch: "sapwood/lane-x-42",
    headSha: "abc123",
    diffstat: "1 file changed, 2 insertions(+), 0 deletions(-)",
  };
  const body = renderCapSplitWipComment({ splitLabel: "sapwood:split", maxResumes: 2, attempts: 2 }, pointer);
  assert.deepEqual(findCapSplitWipPointer([engineComment(ACTOR, body)], ACTOR, 42), pointer);
});

test("renderCapSplitWipComment: a pointer with no PR/branch/head/diffstat still round-trips honestly (issue only)", () => {
  const pointer: CapSplitWipPointer = { issue: 9 };
  const body = renderCapSplitWipComment({ splitLabel: "sapwood:split", maxResumes: 1, attempts: 1 }, pointer);
  assert.match(body, /no PR opened for this WIP yet/);
  assert.deepEqual(findCapSplitWipPointer([engineComment(ACTOR, body)], ACTOR, 9), pointer);
});

test("findCapSplitWipPointer: null for no marker, wrong issue, malformed JSON, or a marker with no closing suffix — fail-closed, never a throw", () => {
  assert.equal(findCapSplitWipPointer([], ACTOR, 1), null);
  assert.equal(findCapSplitWipPointer([engineComment(ACTOR, "just a normal comment")], ACTOR, 1), null);
  const body = renderCapSplitWipComment({ splitLabel: "s", maxResumes: 1, attempts: 1 }, { issue: 5 });
  assert.equal(findCapSplitWipPointer([engineComment(ACTOR, body)], ACTOR, 999), null, "the marker names issue 5, not 999");
  assert.equal(findCapSplitWipPointer([engineComment(ACTOR, "<!-- sapwood:cap-split-wip:{not json} -->")], ACTOR, 5), null);
  assert.equal(
    findCapSplitWipPointer([engineComment(ACTOR, '<!-- sapwood:cap-split-wip:{"issue":5}')], ACTOR, 5),
    null,
    "no closing suffix",
  );
});

test("findCapSplitWipPointer: scans multiple comments and returns the first matching marker from the engine actor", () => {
  const other = renderCapSplitWipComment({ splitLabel: "s", maxResumes: 1, attempts: 1 }, { issue: 6 });
  const mine = renderCapSplitWipComment({ splitLabel: "s", maxResumes: 1, attempts: 1 }, { issue: 5, pr: 1 });
  const found = findCapSplitWipPointer(
    [engineComment(ACTOR, "unrelated"), engineComment(ACTOR, other), engineComment(ACTOR, mine)],
    ACTOR,
    5,
  );
  assert.deepEqual(found, { issue: 5, pr: 1 });
});

// ── #965: the marker alone proves nothing about who wrote it ──────────────────────────────────

test("findCapSplitWipPointer: a schema-valid marker from a NON-engine author is ignored — spoofed provenance never counts", () => {
  const pointer: CapSplitWipPointer = { issue: 5, pr: 99, branch: "attacker/fake-branch" };
  const body = renderCapSplitWipComment({ splitLabel: "s", maxResumes: 1, attempts: 1 }, pointer);
  // Carries the marker text but from a DIFFERENT login than the resolved actor — same shape an
  // arbitrary commenter on a public repo could post.
  assert.equal(findCapSplitWipPointer([engineComment("random-commenter", body)], ACTOR, 5), null);
});

test("findCapSplitWipPointer: the right author but missing ENGINE_COMMENT_MARKER is ignored — marker AND actor, never either alone", () => {
  const pointer: CapSplitWipPointer = { issue: 5 };
  const body = renderCapSplitWipComment({ splitLabel: "s", maxResumes: 1, attempts: 1 }, pointer);
  // Right login, but no ENGINE_COMMENT_MARKER stamp — e.g. the actor's OWN login was reused by a
  // repo collaborator with write access, or a comment this fixture deliberately did not stamp.
  assert.equal(findCapSplitWipPointer([{ login: ACTOR, body }], ACTOR, 5), null);
});

test("findCapSplitWipPointer: an unresolvable actor (null) exempts NOTHING — the maximally fail-closed reading, same stance checkCommentCursorFreshness documents", () => {
  const pointer: CapSplitWipPointer = { issue: 5 };
  const body = renderCapSplitWipComment({ splitLabel: "s", maxResumes: 1, attempts: 1 }, pointer);
  assert.equal(findCapSplitWipPointer([engineComment(ACTOR, body)], null, 5), null);
});

// ── summarizeUnifiedDiffStat ─────────────────────────────────────────────────────────────────

test("summarizeUnifiedDiffStat: counts files/insertions/deletions and excludes the per-file header block (--- / +++ / index) from the content count", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "index 111..222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,3 +1,4 @@",
    " unchanged",
    "+line one",
    "+line two",
    "-old line",
    "diff --git a/b.ts b/b.ts",
    "index 333..444 100644",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1,1 +0,0 @@",
    "-only a deletion",
  ].join("\n");
  assert.equal(summarizeUnifiedDiffStat(diff), "2 files changed, 2 insertions(+), 2 deletions(-)");
});

test("summarizeUnifiedDiffStat: singular grammar at exactly one, and an empty diff reads as zero everything", () => {
  assert.equal(summarizeUnifiedDiffStat(""), "0 files changed, 0 insertions(+), 0 deletions(-)");
  const oneFileOneLine = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -0,0 +1 @@", "+only line"].join("\n");
  assert.equal(summarizeUnifiedDiffStat(oneFileOneLine), "1 file changed, 1 insertion(+), 0 deletions(-)");
});

test("summarizeUnifiedDiffStat (#965): an added line whose OWN content starts with '++ ' is counted as an insertion, not mistaken for a +++ file header", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,1 +1,2 @@",
    " unchanged",
    "++ tricky added line starting with plus-plus-space",
  ].join("\n");
  assert.equal(summarizeUnifiedDiffStat(diff), "1 file changed, 1 insertion(+), 0 deletions(-)");
});

test("summarizeUnifiedDiffStat (#965): a removed line whose OWN content starts with '-- ' is counted as a deletion, not mistaken for a --- file header", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1,1 @@",
    " unchanged",
    "-- tricky removed line starting with dash-dash-space",
  ].join("\n");
  assert.equal(summarizeUnifiedDiffStat(diff), "1 file changed, 0 insertions(+), 1 deletion(-)");
});

test("summarizeUnifiedDiffStat: a file with no hunks at all (pure rename/mode change) contributes zero content lines", () => {
  const diff = ["diff --git a/old.ts b/new.ts", "similarity index 100%", "rename from old.ts", "rename to new.ts"].join("\n");
  assert.equal(summarizeUnifiedDiffStat(diff), "1 file changed, 0 insertions(+), 0 deletions(-)");
});

// ── wasCapSplitByState ───────────────────────────────────────────────────────────────────────

test("wasCapSplitByState: true only for a resume-capped event naming this issue with split:true", () => {
  const events = [
    { id: 1, kind: "resume-capped", payload: { issue: 5, split: false } },
    { id: 2, kind: "resume-capped", payload: { issue: 6, split: true } },
    { id: 3, kind: "dispatched", payload: { issue: 5 } },
  ];
  const state = { eventsAfterId: () => events };
  assert.equal(wasCapSplitByState(state, 5), false, "split:false on the right issue does not count");
  assert.equal(wasCapSplitByState(state, 6), true);
  assert.equal(wasCapSplitByState(state, 7), false, "no event at all for this issue");
});

test("wasCapSplitByState: a malformed/null payload never throws — fail-closed to false", () => {
  const events = [{ id: 1, kind: "resume-capped", payload: null }];
  const state = { eventsAfterId: () => events };
  assert.equal(wasCapSplitByState(state, 5), false);
});
