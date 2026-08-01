// review/ci-evidence.test.ts (#287, E4b) — the deterministic CI-execution-evidence fixture matrix
// (design #279 §4): SKIPPED / NEUTRAL / legacy StatusContext / foreign-app all must fail to
// satisfy a configured `ci.requiredChecks` entry; only a SUCCESS CheckRun from the CONFIGURED app
// satisfies it. One test per rejected shape, plus the empty-required-list fail-closed case.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PRCheckItem } from "../forge/forge.js";
import { requiredChecksRed, requiredChecksSatisfied } from "./ci-evidence.js";

const REQUIRED = [{ name: "test", app: "github-actions" }];

function check(overrides: Partial<PRCheckItem>): PRCheckItem {
  return { name: "test", status: "COMPLETED", conclusion: "SUCCESS", state: null, appSlug: "github-actions", ...overrides };
}

test("requiredChecksSatisfied: a matching SUCCESS CheckRun from the configured app satisfies", () => {
  const result = requiredChecksSatisfied([check({})], REQUIRED);
  assert.deepEqual(result, { ok: true, unsatisfied: [] });
});

test("requiredChecksSatisfied: SKIPPED conclusion does NOT satisfy", () => {
  const result = requiredChecksSatisfied([check({ conclusion: "SKIPPED" })], REQUIRED);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unsatisfied, ["test@github-actions"]);
});

test("requiredChecksSatisfied: NEUTRAL conclusion does NOT satisfy", () => {
  const result = requiredChecksSatisfied([check({ conclusion: "NEUTRAL" })], REQUIRED);
  assert.equal(result.ok, false);
});

test("requiredChecksSatisfied: a legacy StatusContext entry (state set, no appSlug) does NOT satisfy — no check-suite/App concept exists for it", () => {
  const legacy: PRCheckItem = { name: "test", status: "", conclusion: null, state: "SUCCESS", appSlug: null };
  const result = requiredChecksSatisfied([legacy], REQUIRED);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unsatisfied, ["test@github-actions"]);
});

test("requiredChecksSatisfied: a same-named check from a FOREIGN app does NOT satisfy", () => {
  const result = requiredChecksSatisfied([check({ appSlug: "some-other-ci-app" })], REQUIRED);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unsatisfied, ["test@github-actions"]);
});

test("requiredChecksSatisfied: a queued/in-progress check (null conclusion) does NOT satisfy", () => {
  const result = requiredChecksSatisfied([check({ conclusion: null, status: "IN_PROGRESS" })], REQUIRED);
  assert.equal(result.ok, false);
});

test("requiredChecksSatisfied (design #279 §4.3): an EMPTY required list can never be satisfied — fail-closed even with checks present", () => {
  const result = requiredChecksSatisfied([check({})], []);
  assert.equal(result.ok, false);
  assert.equal(result.unsatisfied.length, 1);
});

test("requiredChecksSatisfied: multiple required entries — every one must independently match; a partial match still fails, naming only the unsatisfied ones", () => {
  const required = [
    { name: "test", app: "github-actions" },
    { name: "lint", app: "github-actions" },
  ];
  const result = requiredChecksSatisfied([check({ name: "test" })], required);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unsatisfied, ["lint@github-actions"]);
});

test("requiredChecksSatisfied: an unrelated extra check in the page never counts toward an entry it doesn't name", () => {
  const result = requiredChecksSatisfied([check({ name: "some-other-check" })], REQUIRED);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unsatisfied, ["test@github-actions"]);
});

// ── #503: requiredChecksRed — the RED subset ─────────────────────────────────────────────────

test("requiredChecksRed (#503): a required check with a trusted FAILURE conclusion is red", () => {
  assert.deepEqual(
    requiredChecksRed(
      [{ name: "test", status: "COMPLETED", conclusion: "FAILURE", state: null, appSlug: "github-actions" }],
      [{ name: "test", app: "github-actions" }],
    ),
    ["test@github-actions"],
  );
});

test("requiredChecksRed (#503): pending (null conclusion) is NOT red — it stays in the WAIT class", () => {
  assert.deepEqual(
    requiredChecksRed(
      [{ name: "test", status: "IN_PROGRESS", conclusion: null, state: null, appSlug: "github-actions" }],
      [{ name: "test", app: "github-actions" }],
    ),
    [],
  );
});

test("requiredChecksRed (#503): SKIPPED / CANCELLED conclusions are NOT red — a fix leg cannot re-run them", () => {
  for (const conclusion of ["SKIPPED", "CANCELLED", "NEUTRAL"]) {
    assert.deepEqual(
      requiredChecksRed(
        [{ name: "test", status: "COMPLETED", conclusion, state: null, appSlug: "github-actions" }],
        [{ name: "test", app: "github-actions" }],
      ),
      [],
      conclusion,
    );
  }
});

test("requiredChecksRed (#503): a FAILURE from a FOREIGN app is NOT red — untrusted evidence proves nothing in either direction", () => {
  assert.deepEqual(
    requiredChecksRed(
      [{ name: "test", status: "COMPLETED", conclusion: "FAILURE", state: null, appSlug: "evil-app" }],
      [{ name: "test", app: "github-actions" }],
    ),
    [],
  );
});

test("requiredChecksRed (#503): empty required list returns empty — the fail-closed config shape is not a fix-leg problem", () => {
  assert.deepEqual(
    requiredChecksRed([{ name: "test", status: "COMPLETED", conclusion: "FAILURE", state: null, appSlug: "github-actions" }], []),
    [],
  );
});
