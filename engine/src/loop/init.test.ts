import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfig } from "../config/config.js";
import {
  defaultDoctrineTemplatePath,
  defaultGoalTemplatePath,
  init,
  missing,
  parseAuthScopes,
  preflight,
  requiredLabels,
  resolveDoctrineFilePath,
  resolveGoalFilePath,
  setStatusOptionsArgs,
  InitError,
} from "./init.js";
import type { GhRunner } from "../forge/gh.js";

const cfg = parseConfig("board: { owner: acme, repo: widgets, projectNumber: 7 }");
const OK_AUTH = "github.com\n  ✓ Logged in to github.com account x\n  - Token scopes: 'repo', 'read:org', 'project'\n";

test("parseAuthScopes handles quoted and bare lists", () => {
  assert.deepEqual(parseAuthScopes("  - Token scopes: 'gist', 'repo', 'project'"), ["gist", "repo", "project"]);
  assert.deepEqual(parseAuthScopes("- Token scopes: repo, read:org, project"), ["repo", "read:org", "project"]);
  assert.deepEqual(parseAuthScopes("no scopes line here"), []);
});

test("setStatusOptionsArgs inlines an existing option's id but omits it for a brand-new option", () => {
  const args = setStatusOptionsArgs("FIELD_ID", [
    { id: "OPT_1", name: "Ready", color: "GREEN", description: "queued" },
    { name: "Blocked", color: "GRAY", description: "" }, // no id: never existed before
  ]);
  const query = args.find((a) => a.startsWith("query=")) ?? "";
  assert.ok(query.includes('id:"OPT_1", name:"Ready"'), "existing option keeps its id");
  assert.ok(!query.includes('name:"Blocked"') || !/id:"[^"]*"\s*,\s*name:"Blocked"/.test(query), "new option has no id");
  assert.ok(args.includes("-F"));
  assert.ok(args.some((a) => a === "f=FIELD_ID"));
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
  assert.ok(names.includes("origin:agent")); // #16: provenance convention (see docs/security.md)
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

test("preflight is not fooled by a second, unauthenticated host", async () => {
  const multi =
    "github.com\n  ✓ Logged in to github.com account x\n  - Token scopes: 'repo', 'project'\n" +
    "ghe.example.com\n  X Not logged in to ghe.example.com\n";
  await preflight(async () => multi); // github.com is authed with project → resolves
});

// --- a fake gh runner that records calls and answers the queries init makes ----------
// boardOptions accepts either bare names (an id is synthesized as `id-<name>`, standing in
// for whatever id the real API assigned when the option was first created) or explicit
// {name, id} pairs when a test needs to assert a *specific* id survives the round trip.
function fakeRun(opts: {
  labels?: string[];
  milestones?: string[];
  boardExists?: boolean;
  boardOptions?: (string | { name: string; id: string })[];
  ownerType?: string;
}) {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "label" && args[1] === "list") {
      return JSON.stringify((opts.labels ?? []).map((name) => ({ name })));
    }
    if (args[0] === "label" && args[1] === "create") return "";
    if (args[0] === "api" && args[1]?.includes("/milestones") && args.includes("--jq")) {
      return (opts.milestones ?? []).join("\n"); // --jq '.[].title' => one title per line
    }
    if (args[0] === "api" && args[1]?.endsWith("/milestones")) return ""; // create
    if (args[0] === "api" && args[1]?.startsWith("users/")) return opts.ownerType ?? "User";
    if (args[0] === "api" && args[1] === "graphql") {
      const q = args.find((a) => a.startsWith("query=")) ?? "";
      if (q.includes("mutation")) return JSON.stringify({ data: { updateProjectV2Field: { projectV2Field: { id: "F" } } } });
      const options = (opts.boardOptions ?? []).map((o) =>
        typeof o === "string" ? { id: `id-${o}`, name: o, color: "GRAY", description: "" } : { ...o, color: "GRAY", description: "" },
      );
      const projectV2 = opts.boardExists ? { id: "P", field: { id: "F", options } } : null;
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

test("board mutation preserves existing option ids (guards against issue #37's status wipe)", async () => {
  // "In Progress" and "Done" already exist on the board with real ids from a prior run.
  // Adding the missing "Ready" lane must resend those two WITH their existing ids — the only
  // thing (per ProjectV2SingleSelectFieldOptionInput.id) that stops updateProjectV2Field from
  // minting fresh ids and reverting every item currently on those lanes to "No Status".
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: [
      { name: "In Progress", id: "OPT_IN_PROGRESS" },
      { name: "Done", id: "OPT_DONE" },
    ],
  });
  const dir = tmpCwd();
  try {
    await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    const mutationCall = calls.find((c) => c.join(" ").includes("mutation"));
    assert.ok(mutationCall, "board mutation issued");
    const query = mutationCall!.find((a) => a.startsWith("query=")) ?? "";
    assert.ok(query.includes('id:"OPT_IN_PROGRESS"'), "In Progress kept its existing id");
    assert.ok(query.includes('id:"OPT_DONE"'), "Done kept its existing id");
    // The new "Ready" option has no prior id — the API mints one, so it must NOT appear
    // with a fabricated id (no item references it yet, so there is nothing to preserve).
    const readyOption = query.slice(query.indexOf('name:"Ready"') - 40, query.indexOf('name:"Ready"'));
    assert.ok(!readyOption.includes("id:"), "new option sent without an id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("milestones: only missing ones are created (idempotent, line-parsed)", async () => {
  const cfgMs = parseConfig("board: { owner: acme, repo: widgets, projectNumber: 7 }\nmilestones: [M0, M1, v1.0]");
  const { run, calls } = fakeRun({ labels: requiredLabels(cfgMs).map((l) => l.name), milestones: ["M0", "v1.0"], boardExists: true, boardOptions: ["Ready", "In Progress", "Done"] });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfgMs, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    const created = calls.filter((c) => c[0] === "api" && c[1]?.endsWith("/milestones") && c.includes("-f"));
    assert.equal(created.length, 1, "only M1 created");
    assert.ok(created[0]!.some((a) => a === "title=M1"));
    // list query uses state=all so closed milestones aren't re-created
    assert.ok(calls.some((c) => c[1] === "repos/acme/widgets/milestones?state=all"));
    assert.ok(actions.some((a) => /created milestone\(s\): M1/.test(a)));
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

// ── #128: north-star goal-file scaffold — init creates it iff missing, never overwrites ────────

test("resolveGoalFilePath: a relative goal.file resolves against cwd; an absolute one is left untouched", () => {
  assert.equal(resolveGoalFilePath("docs/PLAN.md", "/repo"), join("/repo", "docs", "PLAN.md"));
  assert.equal(resolveGoalFilePath("/elsewhere/GOAL.md", "/repo"), "/elsewhere/GOAL.md");
});

test("defaultGoalTemplatePath resolves to a real, readable shipped file with the expected sections", () => {
  const path = defaultGoalTemplatePath();
  assert.ok(existsSync(path), `expected shipped template at ${path}`);
  const text = readFileSync(path, "utf8");
  assert.match(text, /^# Goal/m);
  assert.match(text, /^## Non-goals/m);
  assert.match(text, /^## Constraints/m);
  // Gate② P2 (PR #162): architect.ts's loadArchitectureChapter reads exactly this heading from
  // the resolved goal file — without it, a repo bootstrapped by `sapwood init` hands the
  // architect a missing chapter from day one (degrading to the advisory placeholder every round).
  assert.match(text, /^## Architecture/m);
  assert.match(text, /^## Current milestone/m);
});

test("init scaffolds the goal-file template when the resolved path is missing", async () => {
  const { run } = fakeRun({ labels: requiredLabels(cfg).map((l) => l.name), boardExists: true, boardOptions: ["Ready", "In Progress", "Done"] });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    const goalPath = join(dir, "docs", "PLAN.md"); // cfg.goal.file defaults to docs/PLAN.md
    assert.ok(existsSync(goalPath), "goal file was scaffolded");
    const scaffolded = readFileSync(goalPath, "utf8");
    assert.match(scaffolded, /^# Goal/m);
    // Gate② P2 (PR #162): the scaffolded file must carry the ## Architecture section the
    // architect peripheral extracts (loadArchitectureChapter) — a freshly-init'd repo should
    // never start life with a missing chapter.
    assert.match(scaffolded, /^## Architecture/m);
    assert.ok(actions.some((a) => /wrote starter goal file/.test(a)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init never overwrites an existing goal file — byte-for-byte untouched, even with different content (idempotent, crash-rerun safe)", async () => {
  const { run } = fakeRun({ labels: requiredLabels(cfg).map((l) => l.name), boardExists: true, boardOptions: ["Ready", "In Progress", "Done"] });
  const dir = tmpCwd();
  try {
    const goalPath = join(dir, "docs", "PLAN.md");
    mkdirSync(join(dir, "docs"), { recursive: true });
    const userContent = "# My own plan\n\nThis is a user's real document, not a template.\n";
    writeFileSync(goalPath, userContent);

    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });

    assert.equal(readFileSync(goalPath, "utf8"), userContent, "existing goal file must be byte-for-byte untouched");
    assert.ok(actions.some((a) => /goal file already present/.test(a)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: a second run against a repo where init itself scaffolded the goal file is also a no-op (re-running init twice never overwrites)", async () => {
  const { run } = fakeRun({ labels: requiredLabels(cfg).map((l) => l.name), boardExists: true, boardOptions: ["Ready", "In Progress", "Done"] });
  const dir = tmpCwd();
  try {
    await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    const goalPath = join(dir, "docs", "PLAN.md");
    const firstWrite = readFileSync(goalPath, "utf8");

    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });

    assert.equal(readFileSync(goalPath, "utf8"), firstWrite);
    assert.ok(actions.some((a) => /goal file already present/.test(a)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init scaffolds the goal file at a custom goal.file location, creating intermediate directories", async () => {
  const customCfg = parseConfig("board: { owner: acme, repo: widgets, projectNumber: 7 }\ngoal: { file: notes/nested/GOAL.md }");
  const { run } = fakeRun({ labels: requiredLabels(customCfg).map((l) => l.name), boardExists: true, boardOptions: ["Ready", "In Progress", "Done"] });
  const dir = tmpCwd();
  try {
    const { actions } = await init(customCfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    const goalPath = join(dir, "notes", "nested", "GOAL.md");
    assert.ok(existsSync(goalPath));
    assert.ok(actions.some((a) => /wrote starter goal file/.test(a)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #167: repo-level review-doctrine file scaffold — same iff-missing/never-overwrite shape ────

test("resolveDoctrineFilePath: a relative doctrine.file resolves against cwd; an absolute one is left untouched", () => {
  assert.equal(resolveDoctrineFilePath("docs/REVIEW-DOCTRINE.md", "/repo"), join("/repo", "docs", "REVIEW-DOCTRINE.md"));
  assert.equal(resolveDoctrineFilePath("/elsewhere/DOCTRINE.md", "/repo"), "/elsewhere/DOCTRINE.md");
});

test("defaultDoctrineTemplatePath resolves to a real, readable shipped file with the seed content", () => {
  const path = defaultDoctrineTemplatePath();
  assert.ok(existsSync(path), `expected shipped template at ${path}`);
  const text = readFileSync(path, "utf8");
  assert.match(text, /^# Review doctrine/m);
  assert.match(text, /^## Technical invariants/m);
  assert.match(text, /disabled-consumer rule/i);
  assert.match(text, /same-tick window rule/i);
  assert.match(text, /crash-rerun set/i);
  assert.match(text, /doctrine self-modification rule/i);
  assert.match(text, /safety-layer cross-check rule/i);
  assert.match(text, /unwired-function rule/i);
  assert.match(text, /^## Adjudication doctrine/m);
  assert.match(text, /inputs, not truth/i);
});

test("init scaffolds the doctrine-file template when the resolved path is missing", async () => {
  const { run } = fakeRun({ labels: requiredLabels(cfg).map((l) => l.name), boardExists: true, boardOptions: ["Ready", "In Progress", "Done"] });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    const doctrinePath = join(dir, "docs", "REVIEW-DOCTRINE.md"); // cfg.doctrine.file defaults to docs/REVIEW-DOCTRINE.md
    assert.ok(existsSync(doctrinePath), "doctrine file was scaffolded");
    const scaffolded = readFileSync(doctrinePath, "utf8");
    assert.match(scaffolded, /^# Review doctrine/m);
    assert.ok(actions.some((a) => /wrote starter doctrine file/.test(a)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init never overwrites an existing doctrine file — byte-for-byte untouched, even with different content (idempotent, crash-rerun safe)", async () => {
  const { run } = fakeRun({ labels: requiredLabels(cfg).map((l) => l.name), boardExists: true, boardOptions: ["Ready", "In Progress", "Done"] });
  const dir = tmpCwd();
  try {
    const doctrinePath = join(dir, "docs", "REVIEW-DOCTRINE.md");
    mkdirSync(join(dir, "docs"), { recursive: true });
    const userContent = "# Our own doctrine\n\nA repo's real, edited doctrine document.\n";
    writeFileSync(doctrinePath, userContent);

    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });

    assert.equal(readFileSync(doctrinePath, "utf8"), userContent, "existing doctrine file must be byte-for-byte untouched");
    assert.ok(actions.some((a) => /doctrine file already present/.test(a)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: a second run against a repo where init itself scaffolded the doctrine file is also a no-op (re-running init twice never overwrites)", async () => {
  const { run } = fakeRun({ labels: requiredLabels(cfg).map((l) => l.name), boardExists: true, boardOptions: ["Ready", "In Progress", "Done"] });
  const dir = tmpCwd();
  try {
    await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    const doctrinePath = join(dir, "docs", "REVIEW-DOCTRINE.md");
    const firstWrite = readFileSync(doctrinePath, "utf8");

    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });

    assert.equal(readFileSync(doctrinePath, "utf8"), firstWrite);
    assert.ok(actions.some((a) => /doctrine file already present/.test(a)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init scaffolds the doctrine file at a custom doctrine.file location, creating intermediate directories", async () => {
  const customCfg = parseConfig("board: { owner: acme, repo: widgets, projectNumber: 7 }\ndoctrine: { file: notes/nested/DOCTRINE.md }");
  const { run } = fakeRun({ labels: requiredLabels(customCfg).map((l) => l.name), boardExists: true, boardOptions: ["Ready", "In Progress", "Done"] });
  const dir = tmpCwd();
  try {
    const { actions } = await init(customCfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    const doctrinePath = join(dir, "notes", "nested", "DOCTRINE.md");
    assert.ok(existsSync(doctrinePath));
    assert.ok(actions.some((a) => /wrote starter doctrine file/.test(a)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
