import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfig } from "./config.js";
import { init, missing, parseAuthScopes, preflight, requiredLabels, InitError } from "./init.js";
import type { GhRunner } from "./gh.js";

const cfg = parseConfig("board: { owner: acme, repo: widgets, projectNumber: 7 }");
const OK_AUTH = "github.com\n  ✓ Logged in to github.com account x\n  - Token scopes: 'repo', 'read:org', 'project'\n";

test("parseAuthScopes handles quoted and bare lists", () => {
  assert.deepEqual(parseAuthScopes("  - Token scopes: 'gist', 'repo', 'project'"), ["gist", "repo", "project"]);
  assert.deepEqual(parseAuthScopes("- Token scopes: repo, read:org, project"), ["repo", "read:org", "project"]);
  assert.deepEqual(parseAuthScopes("no scopes line here"), []);
});

test("missing returns set difference", () => {
  assert.deepEqual(missing(["a", "b", "c"], ["b"]), ["a", "c"]);
  assert.deepEqual(missing(["a"], ["a"]), []);
});

test("requiredLabels includes the config taxonomy and verify:n/a", () => {
  const names = requiredLabels(cfg).map((l) => l.name);
  assert.ok(names.includes("type:feature"));
  assert.ok(names.includes("prio:0"));
  assert.ok(names.includes("in-progress"));
  assert.ok(names.includes("verify:n/a"));
});

test("preflight throws actionably when not logged in", async () => {
  await assert.rejects(
    () => preflight(async () => "You are not logged in to any GitHub hosts."),
    (e: Error) => e instanceof InitError && /gh auth login/.test(e.message),
  );
});

test("preflight throws actionably when project scope missing", async () => {
  await assert.rejects(
    () => preflight(async () => "  ✓ Logged in to github.com\n  - Token scopes: 'repo'"),
    (e: Error) => e instanceof InitError && /gh auth refresh -s project/.test(e.message),
  );
});

test("preflight passes with project scope", async () => {
  await preflight(async () => OK_AUTH); // resolves
});

// --- a fake gh runner that records calls and answers the queries init makes ----------
function fakeRun(opts: {
  labels?: string[];
  milestones?: string[];
  boardExists?: boolean;
  boardOptions?: string[];
  ownerType?: string;
}) {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "label" && args[1] === "list") {
      return JSON.stringify((opts.labels ?? []).map((name) => ({ name })));
    }
    if (args[0] === "label" && args[1] === "create") return "";
    if (args[0] === "api" && args[1]?.endsWith("/milestones") && !args.includes("-f")) {
      return JSON.stringify(opts.milestones ?? []);
    }
    if (args[0] === "api" && args[1]?.endsWith("/milestones")) return ""; // create
    if (args[0] === "api" && args[1]?.startsWith("users/")) return opts.ownerType ?? "User";
    if (args[0] === "api" && args[1] === "graphql") {
      const q = args.find((a) => a.startsWith("query=")) ?? "";
      if (q.includes("mutation")) return JSON.stringify({ data: { updateProjectV2Field: { projectV2Field: { id: "F" } } } });
      const projectV2 = opts.boardExists
        ? { id: "P", field: { id: "F", options: (opts.boardOptions ?? []).map((name) => ({ name, color: "GRAY" })) } }
        : null;
      return JSON.stringify({ data: { user: { projectV2 } } });
    }
    return "";
  };
  return { run, calls };
}

const tmpCwd = () => mkdtempSync(join(tmpdir(), "sapwood-init-"));

test("init is idempotent: a fully-provisioned repo creates nothing", async () => {
  const allLabels = requiredLabels(cfg).map((l) => l.name);
  const { run, calls } = fakeRun({ labels: allLabels, boardExists: true, boardOptions: ["Ready", "In Progress", "Done"] });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    assert.ok(actions.some((a) => /labels already present/.test(a)));
    assert.ok(!calls.some((c) => c[0] === "label" && c[1] === "create"), "no label creates");
    assert.ok(!calls.some((c) => c.join(" ").includes("mutation")), "no board mutation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init creates missing labels and provisions a missing board lane", async () => {
  const { run, calls } = fakeRun({ labels: ["type:feature"], boardExists: true, boardOptions: ["In Progress", "Done"] });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    const creates = calls.filter((c) => c[0] === "label" && c[1] === "create");
    assert.ok(creates.length > 0, "created missing labels");
    assert.ok(actions.some((a) => /added Status lane "Ready"/.test(a)));
    assert.ok(calls.some((c) => c.join(" ").includes("mutation")), "board mutation issued");
    // wrote starter config into the empty temp dir
    assert.ok(readdirSync(dir).includes("sapwood.config.yaml"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init reports a missing board instead of silently creating a mismatched one", async () => {
  const { run, calls } = fakeRun({ labels: [], boardExists: false });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    assert.ok(actions.some((a) => /no ProjectV2 #7 found/.test(a)));
    assert.ok(!calls.some((c) => c.join(" ").includes("mutation")), "did not mutate a board");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
