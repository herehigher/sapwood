import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));

// frontend-design.md §2 "Weight budget" — the acceptance bar, checked at review.
const ALLOWED_RUNTIME_DEPS = ["@tanstack/react-query", "animejs", "react", "react-dom"];

test("root package.json lists dashboard as a workspace", () => {
  // §9: without this, root -ws build/test/typecheck silently skip the package and CI lies.
  const root = read("../../package.json");
  assert.ok(root.workspaces.includes("dashboard"), `workspaces=${JSON.stringify(root.workspaces)}`);
});

test("runtime dependencies stay inside the §2 weight budget", () => {
  const pkg = read("../package.json");
  const deps = Object.keys(pkg.dependencies).sort();
  assert.ok(deps.length <= 5, `${deps.length} runtime deps`);
  assert.deepEqual(deps, ALLOWED_RUNTIME_DEPS);
});

test("no chart library and no CSS framework / CSS-in-JS sneaks in", () => {
  const pkg = read("../package.json");
  const all = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];
  const banned = /chart|recharts|d3|victory|tailwind|bootstrap|styled-components|emotion|stitches|sass|less/i;
  assert.deepEqual(
    all.filter((d) => banned.test(d)),
    [],
  );
});

test("dashboard exposes the scripts root -ws relies on", () => {
  const pkg = read("../package.json");
  for (const script of ["build", "test", "typecheck"]) {
    assert.ok(pkg.scripts[script], `missing "${script}" script`);
  }
});
