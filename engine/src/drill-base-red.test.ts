// DRILL (supervised, 2026-08-03): deliberately-failing test to turn the DEFAULT BRANCH HEAD
// CI-red and live-exercise the #502 base-red pin -> escalation -> receipt-first clear chain
// (loop/base-ci.ts). Merged through the human channel with owner sanction; reverted immediately
// after the park->clear observation. If you are reading this on main outside that window,
// the revert failed — delete this file.
import { test } from "node:test";
import assert from "node:assert/strict";

test("DRILL base-red: this test is red BY DESIGN (see file header) — revert PR restores green", () => {
  assert.fail("base-red drill in progress — deliberate failure, see drill/base-red-park PR");
});
