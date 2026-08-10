import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CREDENTIAL_PATTERNS, HOST_ABSOLUTE_PATH } from "./demo/export.ts";

// scaffold.test.ts already checks package.json's declared dependencies for a chart-library
// name; this checks the ACTUAL BUILT BUNDLE the cost strip ships in, per issue #145's own
// verification plan ("inspect the built bundle's dependency list ... confirm no chart-library
// package is present") — a declared-dependency check alone would miss a transitive one dragged
// in by something else and bundled anyway.
const root = fileURLToPath(new URL("..", import.meta.url));
const BANNED = /chart\.js|recharts|d3-|victory-|nivo|apexcharts|billboard\.js|highcharts/i;

// One real build, shared by every test below (#742: the `?demo` export step runs first, exactly
// like `npm run build` — dashboard/package.json — chains it, so `dist/demo-fixture.json` exists by
// the time `vite build` copies `public/` verbatim into `dist/`). A second `vite build` invocation
// per test would double this file's already-nontrivial cost for no reason.
test.before(() => {
  execFileSync("node", ["--import", "tsx", "src/demo/export-cli.ts"], { cwd: root, stdio: "pipe" });
  execFileSync("npx", ["vite", "build"], { cwd: root, stdio: "pipe" });
});

test("the built bundle carries no chart-library code", () => {
  const assetsDir = new URL("../dist/assets/", import.meta.url);
  const files = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
  assert.ok(files.length > 0, "expected at least one built JS chunk");
  for (const file of files) {
    const content = readFileSync(new URL(file, assetsDir), "utf8");
    assert.doesNotMatch(content, BANNED, `${file} appears to bundle a chart library`);
  }
});

// #742 Tier B: the automated post-build check — runs the REAL `?demo` export against the REAL
// committed `demo/source.ts` recording (never a planted sentinel; `demo/export.test.ts` owns that),
// then greps the SHIPPED `dist/demo-fixture.json` for the same credential/host-absolute-path
// patterns the export gate itself enforces. A pass here proves the wiring end to end — the gate ran
// as part of the real build, and its output is what actually got copied into `dist/`.
test("the shipped ?demo fixture contains no credential-shaped string or host-absolute path", () => {
  const content = readFileSync(new URL("../dist/demo-fixture.json", import.meta.url), "utf8");
  for (const { pattern, label } of CREDENTIAL_PATTERNS) {
    assert.doesNotMatch(content, pattern, `dist/demo-fixture.json matches a credential-shaped pattern: ${label}`);
  }
  assert.doesNotMatch(content, HOST_ABSOLUTE_PATH, "dist/demo-fixture.json contains a host-absolute path");
});
