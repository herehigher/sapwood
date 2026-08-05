// branch-protection-warning.test.ts (#633): mirrors managed-permission-warning.test.ts's pattern
// — an injected fake GhRunner, no live `gh`. Covers the three read states (protected via legacy,
// protected via ruleset only, confirmed-unprotected), the fail-open read-error/malformed arms,
// and the once-per-start guard the returned closure carries.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhRunner } from "../forge/gh.js";
import { createBranchProtectionDetector, readBranchProtectionState } from "./branch-protection-warning.js";

const REPO = "acme/widgets";

function fakeRun(handlers: Record<string, string | Error>): GhRunner {
  return async (args: string[]) => {
    const key = args.join(" ");
    const match = Object.entries(handlers).find(([pattern]) => key.includes(pattern));
    if (!match) throw new Error(`fakeRun: no handler for "${key}"`);
    const [, result] = match;
    if (result instanceof Error) throw result;
    return result;
  };
}

test("readBranchProtectionState: legacy protection present -> protected", async () => {
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": "{}",
  });
  assert.deepEqual(await readBranchProtectionState(run, REPO), { kind: "protected" });
});

test("readBranchProtectionState: legacy 404 but a non-empty ruleset covers the branch -> protected", async () => {
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": new Error("gh: Not Found (HTTP 404)"),
    "repos/acme/widgets/rules/branches/main": JSON.stringify([{ id: 1 }]),
  });
  assert.deepEqual(await readBranchProtectionState(run, REPO), { kind: "protected" });
});

test("readBranchProtectionState: legacy 404 and an empty ruleset array -> confirmed-unprotected", async () => {
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": new Error("gh: Not Found (HTTP 404)"),
    "repos/acme/widgets/rules/branches/main": "[]",
  });
  assert.deepEqual(await readBranchProtectionState(run, REPO), { kind: "confirmed-unprotected", branch: "main" });
});

test("readBranchProtectionState: default-branch read fails -> cannot-verify, no throw", async () => {
  const run = fakeRun({ "repos/acme/widgets --jq": new Error("network error") });
  assert.deepEqual(await readBranchProtectionState(run, REPO), { kind: "cannot-verify" });
});

test("readBranchProtectionState: legacy endpoint 403 (not a 404) -> cannot-verify, not confirmed-unprotected", async () => {
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": new Error("gh: HTTP 403 Forbidden"),
  });
  assert.deepEqual(await readBranchProtectionState(run, REPO), { kind: "cannot-verify" });
});

test("readBranchProtectionState: legacy 404 but ruleset read fails -> cannot-verify", async () => {
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": new Error("gh: Not Found (HTTP 404)"),
    "repos/acme/widgets/rules/branches/main": new Error("network error"),
  });
  assert.deepEqual(await readBranchProtectionState(run, REPO), { kind: "cannot-verify" });
});

test("readBranchProtectionState: legacy 404 but ruleset body is malformed JSON -> cannot-verify", async () => {
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": new Error("gh: Not Found (HTTP 404)"),
    "repos/acme/widgets/rules/branches/main": "{ not valid json",
  });
  assert.deepEqual(await readBranchProtectionState(run, REPO), { kind: "cannot-verify" });
});

test("createBranchProtectionDetector: protected -> silent", async () => {
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": "{}",
  });
  const logged: string[] = [];
  const detect = createBranchProtectionDetector(REPO, (line) => logged.push(line), { run });
  assert.equal(await detect(), false);
  assert.equal(logged.length, 0);
});

test("createBranchProtectionDetector: ruleset-only protection -> silent", async () => {
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": new Error("gh: Not Found (HTTP 404)"),
    "repos/acme/widgets/rules/branches/main": JSON.stringify([{ id: 1 }]),
  });
  const logged: string[] = [];
  const detect = createBranchProtectionDetector(REPO, (line) => logged.push(line), { run });
  assert.equal(await detect(), false);
  assert.equal(logged.length, 0);
});

test("createBranchProtectionDetector: verified-absent -> exactly one warning naming the branch and the docs pointer", async () => {
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": new Error("gh: Not Found (HTTP 404)"),
    "repos/acme/widgets/rules/branches/main": "[]",
  });
  const logged: string[] = [];
  const detect = createBranchProtectionDetector(REPO, (line) => logged.push(line), { run });
  assert.equal(await detect(), true);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /"main"/);
  assert.match(logged[0]!, /acme\/widgets/);
  assert.match(logged[0]!, /docs\/security\.md#accepted-blind-spots/);
  // Both operator exits named.
  assert.match(logged[0]!, /enable branch protection/i);
  assert.match(logged[0]!, /consciously accept/i);
});

test("createBranchProtectionDetector: read error -> no full warning, no throw", async () => {
  const run = fakeRun({ "repos/acme/widgets --jq": new Error("network error") });
  const logged: string[] = [];
  const detect = createBranchProtectionDetector(REPO, (line) => logged.push(line), { run });
  await assert.doesNotReject(detect());
  assert.equal(logged.length, 0);
});

test("createBranchProtectionDetector: malformed ruleset response -> no full warning, no throw", async () => {
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": new Error("gh: Not Found (HTTP 404)"),
    "repos/acme/widgets/rules/branches/main": "{ not valid json",
  });
  const logged: string[] = [];
  const detect = createBranchProtectionDetector(REPO, (line) => logged.push(line), { run });
  await assert.doesNotReject(detect());
  assert.equal(logged.length, 0);
});

test("createBranchProtectionDetector: second invocation in one start -> no duplicate read, no duplicate warning", async () => {
  let calls = 0;
  const run: GhRunner = async (args: string[]) => {
    calls++;
    if (args.join(" ").includes("--jq")) return "main\n";
    if (args.join(" ").includes("/branches/main/protection")) throw new Error("gh: Not Found (HTTP 404)");
    return "[]";
  };
  const logged: string[] = [];
  const detect = createBranchProtectionDetector(REPO, (line) => logged.push(line), { run });
  assert.equal(await detect(), true);
  const callsAfterFirst = calls;
  assert.equal(await detect(), false);
  assert.equal(calls, callsAfterFirst, "second invocation must not read gh again");
  assert.equal(logged.length, 1, "second invocation must not log a duplicate warning");
});
