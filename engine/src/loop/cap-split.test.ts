// cap-split.test.ts (#965): unit coverage for the shared marker vocabulary conductor.ts and
// decompose.ts both read/write at the resume-cap -> engine `split` seam.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CapSplitWipPointer,
  findCapSplitWipPointer,
  hasCapSplitWipComment,
  renderCapSplitWipComment,
  summarizeUnifiedDiffStat,
} from "./cap-split.js";

test("renderCapSplitWipComment + findCapSplitWipPointer round-trip every field", () => {
  const pointer: CapSplitWipPointer = {
    issue: 42,
    pr: 7,
    branch: "sapwood/lane-x-42",
    headSha: "abc123",
    diffstat: "1 file changed, 2 insertions(+), 0 deletions(-)",
  };
  const body = renderCapSplitWipComment({ splitLabel: "sapwood:split", maxResumes: 2, attempts: 2 }, pointer);
  assert.deepEqual(findCapSplitWipPointer([{ body }], 42), pointer);
});

test("renderCapSplitWipComment: a pointer with no PR/branch/head/diffstat still round-trips honestly (issue only)", () => {
  const pointer: CapSplitWipPointer = { issue: 9 };
  const body = renderCapSplitWipComment({ splitLabel: "sapwood:split", maxResumes: 1, attempts: 1 }, pointer);
  assert.match(body, /no PR opened for this WIP yet/);
  assert.deepEqual(findCapSplitWipPointer([{ body }], 9), pointer);
});

test("findCapSplitWipPointer: null for no marker, wrong issue, malformed JSON, or a marker with no closing suffix — fail-closed, never a throw", () => {
  assert.equal(findCapSplitWipPointer([], 1), null);
  assert.equal(findCapSplitWipPointer([{ body: "just a normal comment" }], 1), null);
  const body = renderCapSplitWipComment({ splitLabel: "s", maxResumes: 1, attempts: 1 }, { issue: 5 });
  assert.equal(findCapSplitWipPointer([{ body }], 999), null, "the marker names issue 5, not 999");
  assert.equal(findCapSplitWipPointer([{ body: "<!-- sapwood:cap-split-wip:{not json} -->" }], 5), null);
  assert.equal(findCapSplitWipPointer([{ body: '<!-- sapwood:cap-split-wip:{"issue":5}' }], 5), null, "no closing suffix");
});

test("findCapSplitWipPointer: scans multiple comments and returns the first matching marker", () => {
  const other = renderCapSplitWipComment({ splitLabel: "s", maxResumes: 1, attempts: 1 }, { issue: 6 });
  const mine = renderCapSplitWipComment({ splitLabel: "s", maxResumes: 1, attempts: 1 }, { issue: 5, pr: 1 });
  const found = findCapSplitWipPointer([{ body: "unrelated" }, { body: other }, { body: mine }], 5);
  assert.deepEqual(found, { issue: 5, pr: 1 });
});

test("hasCapSplitWipComment mirrors findCapSplitWipPointer's presence check", () => {
  const body = renderCapSplitWipComment({ splitLabel: "s", maxResumes: 1, attempts: 1 }, { issue: 3 });
  assert.equal(hasCapSplitWipComment([{ body }], 3), true);
  assert.equal(hasCapSplitWipComment([{ body }], 4), false);
  assert.equal(hasCapSplitWipComment([], 3), false);
});

test("summarizeUnifiedDiffStat: counts files/insertions/deletions and excludes +++/--- diff headers from the content count", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "+line one",
    "+line two",
    "-old line",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "-only a deletion",
  ].join("\n");
  assert.equal(summarizeUnifiedDiffStat(diff), "2 files changed, 2 insertions(+), 2 deletions(-)");
});

test("summarizeUnifiedDiffStat: singular grammar at exactly one, and an empty diff reads as zero everything", () => {
  assert.equal(summarizeUnifiedDiffStat(""), "0 files changed, 0 insertions(+), 0 deletions(-)");
  const oneFileOneLine = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "+only line"].join("\n");
  assert.equal(summarizeUnifiedDiffStat(oneFileOneLine), "1 file changed, 1 insertion(+), 0 deletions(-)");
});
