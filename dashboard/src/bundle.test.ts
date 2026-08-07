import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// scaffold.test.ts already checks package.json's declared dependencies for a chart-library
// name; this checks the ACTUAL BUILT BUNDLE the cost strip ships in, per issue #145's own
// verification plan ("inspect the built bundle's dependency list ... confirm no chart-library
// package is present") — a declared-dependency check alone would miss a transitive one dragged
// in by something else and bundled anyway.
const root = fileURLToPath(new URL("..", import.meta.url));
const BANNED = /chart\.js|recharts|d3-|victory-|nivo|apexcharts|billboard\.js|highcharts/i;

test("the built bundle carries no chart-library code", () => {
  execFileSync("npx", ["vite", "build"], { cwd: root, stdio: "pipe" });
  const assetsDir = new URL("../dist/assets/", import.meta.url);
  const files = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
  assert.ok(files.length > 0, "expected at least one built JS chunk");
  for (const file of files) {
    const content = readFileSync(new URL(file, assetsDir), "utf8");
    assert.doesNotMatch(content, BANNED, `${file} appears to bundle a chart library`);
  }
});
