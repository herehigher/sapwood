import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../config/config.js";
import type { GhRunner } from "../forge/gh.js";
import {
  defaultDoctrineTemplatePath,
  defaultGoalTemplatePath,
  defaultIssueTemplatePath,
  InitError,
  ISSUE_TEMPLATE_NAMES,
  init,
  missing,
  parseAuthScopes,
  parseDeployKeyTitles,
  preflight,
  requiredLabels,
  resolveDoctrineFilePath,
  resolveGoalFilePath,
  setStatusOptionsArgs,
  writeDeployKeyPathIntoYamlConfig,
} from "./init.js";

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

test("requiredLabels includes the sapwood-prefixed taxonomy and workflow defaults", () => {
  const names = requiredLabels(cfg).map((l) => l.name);
  assert.ok(names.includes("sapwood:type:feature"));
  assert.ok(names.includes("sapwood:prio:0"));
  assert.ok(names.includes("sapwood:in-progress"));
  assert.ok(names.includes("sapwood:verify:n/a"));
  assert.ok(names.includes("sapwood:plan:approved"));
  assert.ok(names.includes("sapwood:origin:agent")); // #16: provenance convention (see docs/security.md)
});

test("requiredLabels provisions every configured label", () => {
  const names = new Set(requiredLabels(cfg).map((l) => l.name));
  for (const [key, label] of Object.entries(cfg.labels)) {
    if (key === "prefix") continue;
    assert.ok(names.has(label), `missing configured label: ${label}`);
  }
});

test("requiredLabels derives fixed taxonomy names from labels.prefix", () => {
  const custom = parseConfig('board: { owner: acme, repo: widgets, projectNumber: 7 }\nlabels: { prefix: "TEAM:" }');
  const customNames = requiredLabels(custom).map((label) => label.name);
  assert.ok(customNames.includes("team:type:feature"));
  assert.ok(customNames.includes("team:prio:0"));
  assert.ok(customNames.includes("team:needs-human"));

  const bare = parseConfig('board: { owner: acme, repo: widgets, projectNumber: 7 }\nlabels: { prefix: "" }');
  const bareNames = requiredLabels(bare).map((label) => label.name);
  assert.ok(bareNames.includes("type:feature"));
  assert.ok(bareNames.includes("prio:0"));
  assert.ok(bareNames.includes("needs-human"));
});

test("requiredLabels (#248 review round 1, G2): provisions the configured hold label(s) — the shipped default is otherwise unusable on a clean repo", () => {
  const names = requiredLabels(cfg).map((l) => l.name);
  assert.ok(names.includes("sapwood:hold"));

  const custom = parseConfig(
    "board: { owner: acme, repo: widgets, projectNumber: 7 }\nescalation: { holdLabels: [reviewing, do-not-merge] }",
  );
  const customNames = requiredLabels(custom).map((l) => l.name);
  assert.ok(customNames.includes("reviewing") && customNames.includes("do-not-merge"));
});

test("requiredLabels (#400): the hold label's description names purpose/carrier/removal/no-effect-on-issues, fits GitHub's 100-char limit, and is quoted VERBATIM in docs/configuration.md", () => {
  const spec = requiredLabels(cfg).find((l) => l.name === "sapwood:hold");
  assert.ok(spec);
  assert.ok(spec.description.length <= 100, `GitHub caps label descriptions at 100 chars (got ${spec.description.length})`);
  // Purpose + carrier + what removal does + that an issue is not a carrier — the four facts a
  // human picking this label from the GitHub UI needs, with no second surface to explain.
  assert.match(spec.description, /reviewing/i);
  assert.match(spec.description, /\bPR\b/);
  assert.match(spec.description, /resume/i);
  assert.match(spec.description, /issue/i);

  // Same text in the docs — one description, one place to change it (the #397 pairing check).
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const doc = readFileSync(join(repoRoot, "docs", "configuration.md"), "utf8");
  assert.ok(doc.includes(spec.description), `docs/configuration.md must quote the shipped description verbatim: ${spec.description}`);
});

test("requiredLabels (#248 review round 1, G2): dedupes a holdLabels entry against the rest of the taxonomy case-insensitively — never two LabelSpec rows for the same name", () => {
  const custom = parseConfig("board: { owner: acme, repo: widgets, projectNumber: 7 }\nescalation: { holdLabels: [SAPWOOD:TYPE:FEATURE] }");
  const specs = requiredLabels(custom);
  const matches = specs.filter((l) => l.name.toLowerCase() === "sapwood:type:feature");
  assert.equal(matches.length, 1, "a hold label colliding with an existing taxonomy name produces exactly one LabelSpec, not a duplicate");
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
  // #397: a bare name models a label whose description already MATCHES the shipped spec (the
  // ordinary case — `sapwood init` created it); an explicit {name, description} pair models a
  // repo whose text has drifted, which is what the drift report exists to surface.
  labels?: (string | { name: string; description: string })[];
  milestones?: string[];
  boardExists?: boolean;
  boardOptions?: (string | { name: string; id: string })[];
  ownerType?: string;
  labelCreateErrors?: Record<string, string | { message: string; stderr: string }>;
  // #606: `gh repo deploy-key list --jq '.[].title'` response. DEFAULTS to already registered
  // ("sapwood-worker") — every test that doesn't care about deploy-key provisioning takes
  // ensureDeployKey's fast "already registered, no local key file -> WARN and return" path,
  // never reaching sshKeygen/probeSshAuth (so ordinary init tests never shell out to a real
  // `ssh-keygen`/`ssh`, or touch the network). Tests exercising provisioning itself pass `[]`.
  deployKeyTitles?: string[];
  deployKeyAddError?: string;
  defaultBranch?: string; // "api repos/<owner>/<repo> --jq .default_branch"; unset -> "" -> branch-protection check is skipped entirely
  branchProtected?: boolean; // "api repos/<owner>/<repo>/branches/<branch>/protection"
}) {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "label" && args[1] === "list") {
      const shipped = new Map(requiredLabels(cfg).map((spec) => [spec.name, spec.description]));
      return JSON.stringify(
        (opts.labels ?? []).map((entry) =>
          typeof entry === "string" ? { name: entry, description: shipped.get(entry.toLowerCase()) ?? "" } : entry,
        ),
      );
    }
    if (args[0] === "label" && args[1] === "create") {
      const error = opts.labelCreateErrors?.[args[2] ?? ""];
      if (typeof error === "string") throw new Error(error);
      if (error) throw Object.assign(new Error(error.message), { stderr: error.stderr });
      return "";
    }
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
    if (args[0] === "repo" && args[1] === "deploy-key" && args[2] === "list") {
      return (opts.deployKeyTitles ?? ["sapwood-worker"]).join("\n");
    }
    if (args[0] === "repo" && args[1] === "deploy-key" && args[2] === "add") {
      if (opts.deployKeyAddError) throw new Error(opts.deployKeyAddError);
      return "";
    }
    if (args[0] === "api" && args.includes("--jq") && args.includes(".default_branch")) {
      return opts.defaultBranch ?? "";
    }
    if (args[0] === "api" && /\/branches\/[^/]+\/protection$/.test(args[1] ?? "")) {
      if (!opts.branchProtected) throw new Error("Branch not protected");
      return "{}";
    }
    return "";
  };
  return { run, calls };
}

// #606: fast, non-shelling-out, non-networked defaults for InitDeps' new sshKeygen/probeSshAuth
// seams — every test in this file that doesn't explicitly exercise deploy-key provisioning
// passes these implicitly via fakeRun's own "already registered, no local key" default path
// (see fakeRun's deployKeyTitles doc), so these two are only ever invoked by this file's OWN
// #606 tests below, which override them deliberately.
const failSshKeygen = async (): Promise<void> => {
  throw new Error("sshKeygen must not be called in this test");
};
const failProbeSshAuth = async (): Promise<{ ok: boolean; detail?: string }> => {
  throw new Error("probeSshAuth must not be called in this test");
};

const tmpCwd = () => mkdtempSync(join(tmpdir(), "sapwood-init-"));

test("init is idempotent: a fully-provisioned repo creates nothing", async () => {
  const allLabels = requiredLabels(cfg).map((l) => l.name);
  const { run, calls } = fakeRun({ labels: allLabels, boardExists: true, boardOptions: ["Todo", "Ready", "In Progress", "Done"] });
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

test("#397: init REPORTS a drifted label description and modifies nothing — the no-`--force` default stays, the silence does not", async () => {
  const specs = requiredLabels(cfg);
  const drifted = specs.map((spec) =>
    spec.name === cfg.labels.needsHuman ? { name: spec.name, description: "Escalated — stop autonomy, ask a human" } : spec.name,
  );
  const { run, calls } = fakeRun({ labels: drifted, boardExists: true, boardOptions: ["Todo", "Ready", "In Progress", "Done"] });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    const report = actions.filter((a) => a.startsWith("label description drift"));
    assert.equal(report.length, 1, `exactly the one drifted label is reported, got: ${report.join(" | ")}`);
    assert.match(report[0]!, /sapwood:needs-human/);
    assert.match(report[0]!, /Escalated — stop autonomy, ask a human/); // what the repo has
    assert.ok(report[0]!.includes(specs.find((s) => s.name === cfg.labels.needsHuman)!.description)); // what ships
    // ...and NOTHING was written: no create (the label exists), and above all no edit/--force.
    assert.ok(!calls.some((c) => c[0] === "label" && c[1] !== "list"), "drift is reported, never rewritten");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#397: a repo whose descriptions all match the shipped spec reports no drift at all", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    assert.deepEqual(
      actions.filter((a) => a.startsWith("label description drift")),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init detects an existing case-variant label before create", async () => {
  const allLabels = requiredLabels(cfg).map((l) => (l.name === cfg.labels.needsHuman ? "SAPWOOD:Needs-Human" : l.name));
  const { run, calls } = fakeRun({ labels: allLabels, boardExists: true, boardOptions: ["Todo", "Ready", "In Progress", "Done"] });
  const dir = tmpCwd();
  try {
    await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    assert.ok(!calls.some((c) => c[0] === "label" && c[1] === "create"), "case variant was detected, not silently skipped after create");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init lowercases configured label names passed to gh label create", async () => {
  const customCfg = parseConfig(`
board: { owner: acme, repo: widgets, projectNumber: 7 }
labels: { originAgent: Origin:Agent }
`);
  const existing = requiredLabels(customCfg)
    .map((l) => l.name)
    .filter((name) => name !== customCfg.labels.originAgent);
  const { run, calls } = fakeRun({ labels: existing, boardExists: true, boardOptions: ["Todo", "Ready", "In Progress", "Done"] });
  const dir = tmpCwd();
  try {
    await init(customCfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    assert.ok(calls.some((c) => c[0] === "label" && c[1] === "create" && c[2] === "origin:agent"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init accepts loadConfig's non-schema doctrine.fileRaw enrichment", async () => {
  const loadedCfg = parseConfig("board: { owner: acme, repo: widgets, projectNumber: 7 }");
  loadedCfg.doctrine.fileRaw = loadedCfg.doctrine.file;
  const { run } = fakeRun({
    labels: requiredLabels(loadedCfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Ready", "In Progress", "Done"],
  });
  const dir = tmpCwd();
  try {
    await init(loadedCfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
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
    assert.ok(
      calls.some((c) => c.join(" ").includes("mutation")),
      "board mutation issued",
    );
    // wrote starter config into the empty temp dir
    assert.ok(readdirSync(dir).includes("sapwood.config.yaml"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init tolerates an already-existing label missed by the capped list and continues creating others", async () => {
  const planApproved = cfg.labels.planApproved;
  const originAgent = cfg.labels.originAgent;
  const labels = requiredLabels(cfg)
    .map((l) => l.name)
    .filter((name) => name !== planApproved && name !== originAgent);
  const { run, calls } = fakeRun({
    labels,
    labelCreateErrors: { [planApproved]: "label already exists" },
    boardExists: true,
    boardOptions: ["Ready", "In Progress", "Done"],
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    assert.ok(calls.some((c) => c[0] === "label" && c[1] === "create" && c[2] === planApproved));
    assert.ok(calls.some((c) => c[0] === "label" && c[1] === "create" && c[2] === originAgent));
    assert.ok(actions.some((a) => a === `created 1 label(s): ${originAgent}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init propagates label-create errors other than already exists", async () => {
  const customCfg = parseConfig(`
board: { owner: acme, repo: widgets, projectNumber: 7 }
labels: { planApproved: verification already exists }
`);
  const labels = requiredLabels(customCfg)
    .map((l) => l.name)
    .filter((name) => name !== customCfg.labels.planApproved);
  const { run } = fakeRun({
    labels,
    labelCreateErrors: {
      [customCfg.labels.planApproved]: {
        message: `Command failed: gh label create ${customCfg.labels.planApproved}`,
        stderr: "permission denied",
      },
    },
  });
  const dir = tmpCwd();
  try {
    await assert.rejects(
      () => init(customCfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir }),
      (error: Error & { stderr?: string }) => error.stderr === "permission denied",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("board missing only Todo gets one mutation that preserves every existing option id (#37)", async () => {
  // The three engine lanes already exist on the board with real ids from a prior run.
  // Adding the missing backlog lane must resend all three WITH their existing ids — the only
  // thing (per ProjectV2SingleSelectFieldOptionInput.id) that stops updateProjectV2Field from
  // minting fresh ids and reverting every item currently on those lanes to "No Status".
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: [
      { name: "Ready", id: "OPT_READY" },
      { name: "In Progress", id: "OPT_IN_PROGRESS" },
      { name: "Done", id: "OPT_DONE" },
    ],
  });
  const dir = tmpCwd();
  try {
    await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    const mutationCall = calls.find((c) => c.join(" ").includes("mutation"));
    assert.ok(mutationCall, "board mutation issued");
    assert.equal(calls.filter((c) => c.join(" ").includes("mutation")).length, 1);
    const query = mutationCall!.find((a) => a.startsWith("query=")) ?? "";
    assert.ok(query.includes('id:"OPT_READY"'), "Ready kept its existing id");
    assert.ok(query.includes('id:"OPT_IN_PROGRESS"'), "In Progress kept its existing id");
    assert.ok(query.includes('id:"OPT_DONE"'), "Done kept its existing id");
    // The new "Todo" option has no prior id — the API mints one, so it must NOT appear
    // with a fabricated id (no item references it yet, so there is nothing to preserve).
    const backlogOption = query.slice(query.indexOf('name:"Todo"') - 40, query.indexOf('name:"Todo"'));
    assert.ok(!backlogOption.includes("id:"), "new option sent without an id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("milestones: only missing ones are created (idempotent, line-parsed)", async () => {
  const cfgMs = parseConfig("board: { owner: acme, repo: widgets, projectNumber: 7 }\nmilestones: [M0, M1, v1.0]");
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfgMs).map((l) => l.name),
    milestones: ["M0", "v1.0"],
    boardExists: true,
    boardOptions: ["Ready", "In Progress", "Done"],
  });
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
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Ready", "In Progress", "Done"],
  });
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
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Ready", "In Progress", "Done"],
  });
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
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Ready", "In Progress", "Done"],
  });
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
  const { run } = fakeRun({
    labels: requiredLabels(customCfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Ready", "In Progress", "Done"],
  });
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

// ── #194: GitHub issue-template scaffold — each file is created iff missing ─────────────────

test("repo-root issue templates stay byte-identical to the packaged scaffold templates", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  for (const name of ISSUE_TEMPLATE_NAMES) {
    assert.deepEqual(
      readFileSync(join(repoRoot, ".github", "ISSUE_TEMPLATE", name)),
      readFileSync(defaultIssueTemplatePath(name)),
      `${name} drifted from its packaged scaffold copy`,
    );
  }
});

test("default issue-template paths resolve to four readable shipped files with the standard structure", () => {
  for (const name of ISSUE_TEMPLATE_NAMES) {
    const path = defaultIssueTemplatePath(name);
    assert.ok(existsSync(path), `expected shipped issue template at ${path}`);
    const text = readFileSync(path, "utf8");
    assert.match(text, /^---\nname:/);
    assert.match(text, /^## Why$/m);
    assert.match(text, /^## What$/m);
    assert.match(text, /^Out of scope:/m);
    assert.match(text, /^## Acceptance criteria$/m);
    assert.match(text, /^- \[ \]/m);
    assert.match(text, /^## Verification plan$/m);
    assert.doesNotMatch(text, /^### Verification/m);
    assert.equal(/^## Constraints$/m.test(text), name === "feature.md" || name === "fix.md");
  }
});

test("init creates a missing ISSUE_TEMPLATE directory with all four files and reports each action", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Ready", "In Progress", "Done"],
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    const targetDir = join(dir, ".github", "ISSUE_TEMPLATE");
    assert.deepEqual(readdirSync(targetDir).sort(), [...ISSUE_TEMPLATE_NAMES].sort());
    for (const name of ISSUE_TEMPLATE_NAMES) {
      assert.equal(readFileSync(join(targetDir, name), "utf8"), readFileSync(defaultIssueTemplatePath(name), "utf8"));
      assert.ok(actions.some((action) => action === `wrote issue template ${join(targetDir, name)}`));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init never overwrites a pre-existing issue template and an idempotent re-run reports all four present", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Ready", "In Progress", "Done"],
  });
  const dir = tmpCwd();
  try {
    const targetDir = join(dir, ".github", "ISSUE_TEMPLATE");
    mkdirSync(targetDir, { recursive: true });
    const existingPath = join(targetDir, "feature.md");
    const userContent = Buffer.from("custom feature template\n\u0000byte-preserved\n");
    writeFileSync(existingPath, userContent);

    const first = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    assert.deepEqual(readFileSync(existingPath), userContent);
    assert.ok(first.actions.some((action) => action === `issue template already present (${existingPath})`));

    const second = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    assert.deepEqual(readFileSync(existingPath), userContent);
    for (const name of ISSUE_TEMPLATE_NAMES) {
      const path = join(targetDir, name);
      assert.ok(second.actions.some((action) => action === `issue template already present (${path})`));
    }
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
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Ready", "In Progress", "Done"],
  });
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
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Ready", "In Progress", "Done"],
  });
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
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Ready", "In Progress", "Done"],
  });
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
  const { run } = fakeRun({
    labels: requiredLabels(customCfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Ready", "In Progress", "Done"],
  });
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

test("init (#492): the guard-hook action line reports the hook as built and wired per-session, not deferred/unbuilt", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Ready", "In Progress", "Done"],
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir });
    const guardLine = actions.find((a) => a.startsWith("guard hook:"));
    assert.ok(guardLine, "init reports the guard hook");
    // The onboarding message must not claim the repo's core safety mechanism is missing (it
    // has been built and live per worker session since M1/M2).
    assert.doesNotMatch(guardLine!, /not built yet|deferred to M1/);
    assert.match(guardLine!, /built/);
    assert.match(guardLine!, /worker\.ts/); // names who wires it, since init itself does not
    assert.match(guardLine!, /human-merge-only/); // still true, still stated
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #606 (#351 final ruling): L1 scoped-worker-identity deploy-key provisioning ──────────────

test("parseDeployKeyTitles: one title per line (same idiom as ensureMilestones' own --jq '.[].title' parse), blank lines dropped", () => {
  assert.deepEqual(parseDeployKeyTitles("sapwood-worker\nother-key\n"), ["sapwood-worker", "other-key"]);
  assert.deepEqual(parseDeployKeyTitles(""), []);
  assert.deepEqual(parseDeployKeyTitles("\n\n  \n"), []);
});

test("writeDeployKeyPathIntoYamlConfig: inserts deployKeyPath right after the top-level worker: key, preserving every existing line/comment byte-for-byte", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const original =
      "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n\nworker:\n  model: opus # a real comment\n  effort: high\n";
    writeFileSync(cfgPath, original);
    const wrote = writeDeployKeyPathIntoYamlConfig(cfgPath, "data/worker-deploy-key");
    assert.equal(wrote, true);
    const after = readFileSync(cfgPath, "utf8");
    assert.match(after, /^worker:\n {2}deployKeyPath: data\/worker-deploy-key/m);
    // every original line survives untouched — comment included
    for (const line of original.split("\n")) {
      if (line.length > 0) assert.ok(after.includes(line), `original line lost: ${line}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDeployKeyPathIntoYamlConfig: no top-level worker: key -> appends a fresh worker: block at EOF", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n");
    writeDeployKeyPathIntoYamlConfig(cfgPath, "data/worker-deploy-key");
    const after = readFileSync(cfgPath, "utf8");
    assert.match(after, /\nworker:\n {2}deployKeyPath: data\/worker-deploy-key/);
    // still parses as valid config with the key set
    const parsed = parseConfig(after);
    assert.equal(parsed.worker.deployKeyPath, "data/worker-deploy-key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDeployKeyPathIntoYamlConfig: idempotent — a file that already has a deployKeyPath: line (however indented) is left untouched, returns false", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const original = "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\nworker:\n  deployKeyPath: some/existing/path\n";
    writeFileSync(cfgPath, original);
    const wrote = writeDeployKeyPathIntoYamlConfig(cfgPath, "data/worker-deploy-key");
    assert.equal(wrote, false);
    assert.equal(readFileSync(cfgPath, "utf8"), original, "byte-for-byte untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: repo where the operator has admin — provisions the deploy key end-to-end (ssh-keygen + gh repo deploy-key add --allow-write --title sapwood-worker), preflight green, worker.deployKeyPath written into the config file", async () => {
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyTitles: [], // not yet registered -> provisioning runs
  });
  const dir = tmpCwd();
  try {
    let keygenCalledWith: string | undefined;
    let probeCalledWith: string | undefined;
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      sshKeygen: async (path) => {
        keygenCalledWith = path;
        writeFileSync(path, "fake-private-key");
        writeFileSync(`${path}.pub`, "ssh-ed25519 AAAA fake");
      },
      probeSshAuth: async (path) => {
        probeCalledWith = path;
        return { ok: true };
      },
    });
    const expectedKeyPath = join(dir, "data", "worker-deploy-key");
    assert.equal(keygenCalledWith, expectedKeyPath);
    assert.equal(probeCalledWith, expectedKeyPath);
    const addCall = calls.find((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add");
    assert.ok(addCall, "gh repo deploy-key add must be called");
    assert.ok(addCall!.includes("--allow-write"));
    assert.ok(addCall!.includes("--title"));
    assert.equal(addCall![addCall!.indexOf("--title") + 1], "sapwood-worker");
    assert.equal(addCall![3], `${expectedKeyPath}.pub`);
    assert.ok(actions.some((a) => /added write deploy key/.test(a)));
    assert.ok(actions.some((a) => /preflight OK/.test(a)));
    assert.ok(actions.some((a) => /wrote worker\.deployKeyPath/.test(a)));
    const configPath = join(dir, "sapwood.config.yaml");
    const configText = readFileSync(configPath, "utf8");
    assert.match(configText, /deployKeyPath: data[/\\]worker-deploy-key/);
    const reparsed = parseConfig(configText);
    assert.equal(reparsed.worker.deployKeyPath, join("data", "worker-deploy-key"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: idempotent on re-run — a repo where the deploy key title is ALREADY registered and a local key exists skips ssh-keygen/deploy-key-add entirely (no duplicate key)", async () => {
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyTitles: ["sapwood-worker"], // already registered
  });
  const dir = tmpCwd();
  try {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "worker-deploy-key"), "existing-private-key");
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      sshKeygen: failSshKeygen,
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.ok(!calls.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add"), "no duplicate deploy-key add");
    assert.ok(actions.some((a) => /already registered/.test(a)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: a SECOND run against a config that already has worker.deployKeyPath set skips provisioning entirely — no gh deploy-key calls at all, not even a list probe", async () => {
  const provisioned = parseConfig(
    "board: { owner: acme, repo: widgets, projectNumber: 7 }\nworker: { deployKeyPath: data/worker-deploy-key }",
  );
  const { run, calls } = fakeRun({
    labels: requiredLabels(provisioned).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(provisioned, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      sshKeygen: failSshKeygen,
      probeSshAuth: failProbeSshAuth,
    });
    assert.ok(!calls.some((c) => c[0] === "repo" && c[1] === "deploy-key"), "provisioning must be skipped entirely once configured");
    assert.ok(actions.some((a) => /already configured/.test(a)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: without repo-admin (gh repo deploy-key add fails) -> L0 fallback guidance WARN naming the manual ssh-keygen command, the repo Settings -> Deploy keys step, the config key, and a docs anchor; engine stays fully functional", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyTitles: [],
    deployKeyAddError: "HTTP 403: Must have admin rights to Repository.",
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      sshKeygen: async (path) => {
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: failProbeSshAuth,
    });
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn, "expected a guidance-carrying WARN action line");
    assert.match(warn!, /ssh-keygen -t ed25519/, "names the exact manual ssh-keygen command");
    assert.match(warn!, /Deploy keys/, "names the manual repo Settings -> Deploy keys step");
    assert.match(warn!, /write access/i, "names the allow-write step");
    assert.match(warn!, /worker\.deployKeyPath/, "names the config key");
    assert.match(warn!, /docs\/security\.md/, "carries a docs anchor");
    assert.match(warn!, /L0/, "states the engine stays functional at L0");
    // init itself never throws/fails over this — every other action (labels/board/etc) still ran.
    assert.ok(actions.some((a) => /labels already present|created \d+ label/.test(a)));
    const configText = readFileSync(join(dir, "sapwood.config.yaml"), "utf8");
    assert.doesNotMatch(configText, /deployKeyPath:/, "no deployKeyPath written when provisioning failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (#554 pattern): worker.deployKeyPath set but the SSH auth preflight fails -> guidance WARN naming the re-provision instruction; config is NOT written", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyTitles: [],
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      sshKeygen: async (path) => {
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: async () => ({ ok: false, detail: "ssh: connect to host github.com port 22: Network is unreachable" }),
    });
    const warn = actions.find((a) => a.startsWith("deploy key: WARN") && /preflight failed/.test(a));
    assert.ok(warn, "expected a preflight-fail WARN action line");
    assert.match(warn!, /Network is unreachable/);
    assert.match(warn!, /sapwood init/i, "names the re-provision instruction (re-run sapwood init)");
    const configText = readFileSync(join(dir, "sapwood.config.yaml"), "utf8");
    assert.doesNotMatch(configText, /deployKeyPath:/, "no deployKeyPath written when the preflight fails");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (#554 pattern): L1 active + default branch UNPROTECTED -> WARN naming branch protection as the fix", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyTitles: [],
    defaultBranch: "main",
    branchProtected: false,
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      sshKeygen: async (path) => {
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    const warn = actions.find((a) => a.startsWith("deploy key: WARN") && /branch protection|NO branch protection/i.test(a));
    assert.ok(warn, "expected an unprotected-default-branch WARN action line");
    assert.match(warn!, /main/);
    assert.match(warn!, /branch protection/i, "names branch protection as the fix");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: L1 active + default branch IS protected -> a positive confirmation action, no WARN", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyTitles: [],
    defaultBranch: "main",
    branchProtected: true,
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      sshKeygen: async (path) => {
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.ok(!actions.some((a) => a.startsWith("deploy key: WARN") && /branch protection/i.test(a)));
    assert.ok(actions.some((a) => /default branch "main".*is protected/.test(a)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
