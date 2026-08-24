// branch-protection-warning.test.ts (#633): mirrors managed-permission-warning.test.ts's pattern
// — an injected fake GhRunner, no live `gh`. Covers the three read states (protected via legacy,
// protected via ruleset only, confirmed-unprotected), the fail-open read-error/malformed arms,
// and the once-per-start guard the returned closure carries.
//
// #673 fix-leg note: `gh()` (engine/src/forge/gh.ts) is `promisify(execFile)` — a real rejection
// from it is a multi-line `Command failed: <cmd>\n<stderr...>` message, with the HTTP-status
// marker in a LATER line (and often duplicated on a separate `.stderr` property). Errors below
// are shaped that way deliberately — a first-line-only classifier passes none of the 404 arms.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhRunner } from "../forge/gh.js";
import { DOC_LINKS } from "../util/doc-links.js";
import { createBranchProtectionDetector, readBranchProtectionState } from "./branch-protection-warning.js";

const REPO = "acme/widgets";

/** Shapes an error the way Node's execFile (via util.promisify) actually throws: a multi-line
 *  `.message` with the command on line 1 and stderr text starting line 2+, plus the same stderr
 *  text mirrored onto a `.stderr` property (present whenever execFile captured output). */
function execFileError(cmd: string, stderrText: string): Error & { stderr: string } {
  const err = new Error(`Command failed: ${cmd}\n${stderrText}`) as Error & { stderr: string };
  err.stderr = stderrText;
  return err;
}

const notFound404 = execFileError("gh api repos/acme/widgets/branches/main/protection", "gh: Not Found (HTTP 404)\n");
const forbidden403 = execFileError("gh api repos/acme/widgets/branches/main/protection", "gh: HTTP 403 Forbidden\n");

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
    "repos/acme/widgets/branches/main/protection": notFound404,
    "repos/acme/widgets/rules/branches/main": JSON.stringify([{ id: 1 }]),
  });
  assert.deepEqual(await readBranchProtectionState(run, REPO), { kind: "protected" });
});

test("readBranchProtectionState: legacy 404 and an empty ruleset array -> confirmed-unprotected", async () => {
  // Regression for #673: with a first-line-only classifier this fails, because the 404 marker
  // sits on the SECOND line of a real execFile error's message ("Command failed: ...\n...404...").
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": notFound404,
    "repos/acme/widgets/rules/branches/main": "[]",
  });
  assert.deepEqual(await readBranchProtectionState(run, REPO), { kind: "confirmed-unprotected", branch: "main" });
});

test("readBranchProtectionState: 404 marker present only on `.stderr`, not `.message` -> confirmed-unprotected", async () => {
  // Some execFile error shapes carry stderr text ONLY on the `.stderr` property, with `.message`
  // reduced to the bare "Command failed: <cmd>" line. The classifier must still catch it.
  const stderrOnly = new Error("Command failed: gh api repos/acme/widgets/branches/main/protection") as Error & {
    stderr: string;
  };
  stderrOnly.stderr = "gh: Not Found (HTTP 404)\n";
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": stderrOnly,
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
    "repos/acme/widgets/branches/main/protection": forbidden403,
  });
  assert.deepEqual(await readBranchProtectionState(run, REPO), { kind: "cannot-verify" });
});

test("readBranchProtectionState: legacy endpoint 5xx/network failure -> cannot-verify, not confirmed-unprotected", async () => {
  const serverError = execFileError("gh api repos/acme/widgets/branches/main/protection", "gh: Internal Server Error (HTTP 502)\n");
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": serverError,
  });
  assert.deepEqual(await readBranchProtectionState(run, REPO), { kind: "cannot-verify" });
});

test("readBranchProtectionState: collision — command path contains an unrelated 3-digit number, real status is 502 -> cannot-verify, not confirmed-unprotected", async () => {
  // #673 gate② P1 (second pass): a bare `\d{3}` scan over the full text matches the FIRST
  // 3-digit run it finds — including one baked into the repo/branch path itself (e.g. a repo
  // literally named "project-404"), even when the ACTUAL HTTP status a few characters later is a
  // real 502. The marker must be anchored to gh's own "(HTTP <code>)" shape (verified against a
  // real `gh api` 404: stderr reads `gh: Not Found (HTTP 404)`), never a bare 3-digit sequence.
  // The ruleset endpoint MUST have a real handler here (an empty-array "confirmed-unprotected"
  // response, same as the genuine-404 tests above) — otherwise a bare-3-digit false-404 would
  // fall through to fakeRun's "no handler" throw, land in the OTHER cannot-verify arm (ruleset
  // read failure), and pass for the wrong reason, masking the exact bug this test exists to catch.
  const collisionRepo = "acme/project-404";
  const serverErrorWithPathCollision = execFileError(
    `gh api repos/${collisionRepo}/branches/main/protection`,
    "gh: Internal Server Error (HTTP 502)\n",
  );
  const run = fakeRun({
    [`repos/${collisionRepo} --jq`]: "main\n",
    [`repos/${collisionRepo}/branches/main/protection`]: serverErrorWithPathCollision,
    [`repos/${collisionRepo}/rules/branches/main`]: "[]",
  });
  assert.deepEqual(await readBranchProtectionState(run, collisionRepo), { kind: "cannot-verify" });
});

test("readBranchProtectionState: legacy 404 but ruleset read fails -> cannot-verify", async () => {
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": notFound404,
    "repos/acme/widgets/rules/branches/main": new Error("network error"),
  });
  assert.deepEqual(await readBranchProtectionState(run, REPO), { kind: "cannot-verify" });
});

test("readBranchProtectionState: legacy 404 but ruleset body is malformed JSON -> cannot-verify", async () => {
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": notFound404,
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
    "repos/acme/widgets/branches/main/protection": notFound404,
    "repos/acme/widgets/rules/branches/main": JSON.stringify([{ id: 1 }]),
  });
  const logged: string[] = [];
  const detect = createBranchProtectionDetector(REPO, (line) => logged.push(line), { run });
  assert.equal(await detect(), false);
  assert.equal(logged.length, 0);
});

test("createBranchProtectionDetector: verified-absent -> exactly one warning naming the branch and the docs pointer", async () => {
  // Regression for #673: fails against a first-line-only classifier (see notFound404's shape).
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": notFound404,
    "repos/acme/widgets/rules/branches/main": "[]",
  });
  const logged: string[] = [];
  const detect = createBranchProtectionDetector(REPO, (line) => logged.push(line), { run });
  assert.equal(await detect(), true);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /"main"/);
  assert.match(logged[0]!, /acme\/widgets/);
  assert.ok(logged[0]!.includes(DOC_LINKS.securityAcceptedBlindSpots));
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

test("createBranchProtectionDetector: legacy endpoint 5xx -> no unprotected-WARN (stays cannot-verify), no throw", async () => {
  const serverError = execFileError("gh api repos/acme/widgets/branches/main/protection", "gh: Internal Server Error (HTTP 502)\n");
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": serverError,
  });
  const logged: string[] = [];
  const detect = createBranchProtectionDetector(REPO, (line) => logged.push(line), { run });
  await assert.doesNotReject(detect());
  assert.equal(logged.length, 0);
});

test("createBranchProtectionDetector: malformed ruleset response -> no full warning, no throw", async () => {
  const run = fakeRun({
    "repos/acme/widgets --jq": "main\n",
    "repos/acme/widgets/branches/main/protection": notFound404,
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
    if (args.join(" ").includes("/branches/main/protection")) throw notFound404;
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
