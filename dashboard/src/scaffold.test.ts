import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));

// frontend-design.md §2 dependency budget — the acceptance bar, checked at review. A new
// runtime dependency needs a same-PR update here AND a §2 adjudication-table row (owner
// adjudication 2026-08-14).
const ALLOWED_RUNTIME_DEPS = [
  "@fontsource-variable/jetbrains-mono",
  "@radix-ui/react-popover",
  "@radix-ui/react-tooltip",
  "@tanstack/react-query",
  "animejs",
  "clsx",
  "lucide-react",
  "react",
  "react-dom",
];

test("root package.json lists dashboard as a workspace", () => {
  // §9: without this, root -ws build/test/typecheck silently skip the package and CI lies.
  const root = read("../../package.json");
  assert.ok(root.workspaces.includes("dashboard"), `workspaces=${JSON.stringify(root.workspaces)}`);
});

test("runtime dependencies stay inside the §2 dependency budget", () => {
  const pkg = read("../package.json");
  const deps = Object.keys(pkg.dependencies).sort();
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
