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
