import assert from "node:assert/strict";
import test from "node:test";
import { ExportGateError, exportDemoBundle, rewriteAbsolutePaths } from "./export.ts";
import { DEMO_SOURCE } from "./source.ts";
import type { DemoBundle } from "./types.ts";

// #742 Tier A: sentinel positive + clean negative — proving the gate FAILS the build on a planted
// credential-shaped string and on a planted host-absolute path, and PASSES once both are removed.

function withLogPath(logPath: string): DemoBundle {
  return { ...DEMO_SOURCE, loopState: { ...DEMO_SOURCE.loopState, logPath } };
}

test("export gate: fails on a planted credential-shaped sentinel", () => {
  const planted = withLogPath("sk-ant-api03-FAKESENTINEL1234567890abcdefgh");
  assert.throws(() => exportDemoBundle(planted), ExportGateError);
});

test("export gate: fails on a planted host-absolute path with no recognized repo anchor", () => {
  const planted = withLogPath("/Users/someone-elses-machine/private-notes/todo.txt");
  assert.throws(() => exportDemoBundle(planted), ExportGateError);
});

// #793 gate② finding [2] (export-gate-secret-echo): `export-cli.ts` deliberately lets an
// `ExportGateError` reach the build log uncaught — a real planted secret must never round-trip
// into that log verbatim just because THIS gate is what caught it. These pin the redaction
// directly on the thrown error's own message, not just on the (already-covered) fact that a throw
// happens at all.

test("export gate: the thrown error never echoes the matched credential value — only its class", () => {
  const secret = "sk-ant-api03-FAKESENTINEL1234567890abcdefgh";
  assert.throws(
    () => exportDemoBundle(withLogPath(secret)),
    (err: unknown) => {
      assert.ok(err instanceof ExportGateError);
      assert.doesNotMatch(err.message, /sk-ant-api03-FAKESENTINEL/, "the credential value itself must never appear in the error message");
      assert.match(err.message, /Anthropic API key/, "the error should still name WHICH signature class matched");
      return true;
    },
  );
});

test("export gate: the thrown error never echoes the matched host-absolute path's private segments", () => {
  assert.throws(
    () => exportDemoBundle(withLogPath("/Users/someone-elses-machine/private-notes/todo.txt")),
    (err: unknown) => {
      assert.ok(err instanceof ExportGateError);
      assert.doesNotMatch(
        err.message,
        /someone-elses-machine/,
        "the path's private username/hostname must never appear in the error message",
      );
      assert.doesNotMatch(err.message, /private-notes/, "no fragment of the leaked path may appear in the error message");
      return true;
    },
  );
});

test("export gate: passes once both sentinels are removed — the real bundled source is clean", () => {
  const result = exportDemoBundle(DEMO_SOURCE);
  assert.equal(JSON.stringify(result).includes("sk-ant-"), false);
});

test("export gate: the shipped result never contains a raw /Users/ or /home/ path", () => {
  const result = exportDemoBundle(DEMO_SOURCE);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /\/Users\//);
  assert.doesNotMatch(serialized, /\/home\//);
});

// #742 Tier A: a dedicated path-rewrite test, separate from the gate-detection tests above — a
// legitimate host-absolute path (one WITH a recognized repo anchor) is rewritten repo-relative,
// while a fixture's reference to the live `/api/events` path comes through unchanged (§8: the
// live feed's own path is never mistaken for a filesystem path just because it starts with `/`).

test("path rewrite: a legitimate host-absolute path is rewritten repo-relative", () => {
  assert.equal(rewriteAbsolutePaths("/Users/dev/work/sapwood/dashboard/data/run.log"), "dashboard/data/run.log");
  assert.equal(rewriteAbsolutePaths("/home/ci-runner/checkouts/sapwood-dogfood/engine/src/cli.ts"), "engine/src/cli.ts");
});

test("path rewrite: a fixture reference to the live /api/events path comes through unchanged", () => {
  assert.equal(rewriteAbsolutePaths("/api/events"), "/api/events");
  assert.equal(
    rewriteAbsolutePaths("see /api/events?after=0&limit=200 for the live feed"),
    "see /api/events?after=0&limit=200 for the live feed",
  );
});

test("path rewrite end-to-end through exportDemoBundle: the real source logPath is rewritten repo-relative", () => {
  const result = exportDemoBundle(DEMO_SOURCE);
  assert.equal(result.loopState.logPath, "dashboard/data/dogfood-run-5001.log");
});
