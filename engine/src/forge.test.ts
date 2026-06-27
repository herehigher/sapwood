import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePRStatus } from "./forge.js";

test("parsePRStatus: clean mergeable PR with passing checks", () => {
  const s = parsePRStatus(
    JSON.stringify({
      number: 21,
      headRefOid: "d0ce0a5",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
  );
  assert.deepEqual(s, { number: 21, headOid: "d0ce0a5", state: "OPEN", mergeable: true, ciGreen: true });
});

test("parsePRStatus: no checks configured counts as green (docs-only repo)", () => {
  const s = parsePRStatus(
    JSON.stringify({ number: 1, headRefOid: "abc", state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [] }),
  );
  assert.equal(s.ciGreen, true);
});

test("parsePRStatus: a queued/in-progress check (null conclusion) is not green", () => {
  const s = parsePRStatus(
    JSON.stringify({
      number: 3,
      headRefOid: "abc",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: null }],
    }),
  );
  assert.equal(s.ciGreen, false);
});

test("parsePRStatus: SKIPPED/NEUTRAL count as passing", () => {
  const s = parsePRStatus(
    JSON.stringify({
      number: 4,
      headRefOid: "abc",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ conclusion: "SKIPPED" }, { conclusion: "NEUTRAL" }, { conclusion: "SUCCESS" }],
    }),
  );
  assert.equal(s.ciGreen, true);
});

test("parsePRStatus: a failing check is not green", () => {
  const s = parsePRStatus(
    JSON.stringify({
      number: 2,
      headRefOid: "abc",
      state: "OPEN",
      mergeable: "CONFLICTING",
      statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }],
    }),
  );
  assert.equal(s.ciGreen, false);
  assert.equal(s.mergeable, false);
});
