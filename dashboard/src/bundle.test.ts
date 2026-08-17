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

// #894: the real `git rev-parse HEAD` of THIS tree, computed the same way `vite.config.ts`'s
// build-time `define` computes it — asserted against below, not hardcoded, so this test actually
// pins "the embedded value equals the built tree's own SHA" rather than a copied constant that
// could silently drift from it (docs/REVIEW-DOCTRINE.md's VALUE rule).
const realHeadSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();

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

// #894 build-injection test: the build step embeds THIS tree's real git SHA + a build timestamp
// into the shipped bundle — checked against `realHeadSha` (computed independently above, not
// copied), and also against the sidecar `dist/build-meta.json` `server.ts`'s freshness comparison
// reads outside the JS bundle.
test("#894: the built bundle embeds this tree's real git SHA + a build timestamp", () => {
  const assetsDir = new URL("../dist/assets/", import.meta.url);
  const files = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
  const combined = files.map((f) => readFileSync(new URL(f, assetsDir), "utf8")).join("\n");
  assert.match(combined, new RegExp(realHeadSha), "the built bundle must embed the exact SHA of the tree it was built from");
  // The minifier may render string literals with either quote style — match the ISO-8601 shape
  // itself rather than assuming a specific quote character.
  assert.match(combined, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/, "an ISO-8601 build timestamp is embedded alongside the SHA");
});

test("#894: the build also writes a dist/build-meta.json sidecar with the same SHA — the fact server.ts's freshness comparison reads", () => {
  const meta = JSON.parse(readFileSync(new URL("../dist/build-meta.json", import.meta.url), "utf8"));
  assert.equal(meta.sha, realHeadSha);
  assert.match(meta.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
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
