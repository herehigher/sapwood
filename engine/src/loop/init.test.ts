import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runEngine } from "../cli.js";
import { engineAgentEmptyCiRequiredChecksError, parseConfig } from "../config/config.js";
import type { GhRunner } from "../forge/gh.js";
import { State } from "../state/state.js";
import {
  clearDeployKeyConfigFromJson,
  clearDeployKeyConfigFromYaml,
  defaultDoctrineTemplatePath,
  defaultGoalTemplatePath,
  defaultIssueTemplatePath,
  InitError,
  ISSUE_TEMPLATE_NAMES,
  init,
  missing,
  parseAuthScopes,
  parseDeployKeys,
  pickFreshArmAKeySlot,
  preflight,
  requiredLabels,
  resolveDoctrineFilePath,
  resolveGoalFilePath,
  sanitizeHostnameForKeyTitle,
  setStatusOptionsArgs,
  writeDeployKeyConfigIntoYaml,
} from "./init.js";

const cfg = parseConfig("board: { owner: acme, repo: widgets, projectNumber: 7 }");
const OK_AUTH = "github.com\n  ✓ Logged in to github.com account x\n  - Token scopes: 'repo', 'read:org', 'project'\n";

// #606 gate② round 1: deterministic non-interactive defaults for every test that doesn't
// EXPLICITLY exercise the auth-fails/stale/mismatch arm's (a)/(b) operator choice — pins
// isInteractive() to false regardless of whatever real TTY this test process happens to run
// under (a real terminal attached to stdin would otherwise make the REAL default promptOperator
// block on real input and hang the suite). promptOperator throws if ever reached, so a test
// relying on this constant can never silently fall into the interactive branch unnoticed.
const nonInteractive = {
  isInteractive: () => false,
  promptOperator: async (): Promise<string> => {
    throw new Error("promptOperator must not be called when isInteractive() is false");
  },
  hostname: () => "test-host",
};

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

test("#658 review round 2 (B): a holdLabels entry colliding with a taxonomy label name is now rejected AT CONFIG LOAD — the #248 round-1 dedup-in-requiredLabels this superseded is gone", () => {
  assert.throws(
    () => parseConfig("board: { owner: acme, repo: widgets, projectNumber: 7 }\nescalation: { holdLabels: [SAPWOOD:TYPE:FEATURE] }"),
    /escalation\.holdLabels.*collides with the taxonomy label `type:feature`/is,
  );
});

test("requiredLabels: two holdLabels entries that normalize to the SAME name dedupe to one LabelSpec row — not an alias collision (config load doesn't reject two entries asserting the identical fact), so the dedupe here stays", () => {
  const custom = parseConfig("board: { owner: acme, repo: widgets, projectNumber: 7 }\nescalation: { holdLabels: [reviewing, Reviewing] }");
  const specs = requiredLabels(custom);
  const matches = specs.filter((l) => l.name.toLowerCase() === "reviewing");
  assert.equal(
    matches.length,
    1,
    "two holdLabels entries normalizing to the same name must produce exactly one LabelSpec, not a duplicate",
  );
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
  // #606 gate② round 1 (P1-1), round 2 (R3-1): `gh repo deploy-key list --json <fields>`
  // response — DEFAULTS to already registered ("sapwood-worker", id 1) with NO local anchor
  // configured — every test that doesn't care about deploy-key provisioning takes the
  // "sapwood-titled key exists remotely but this machine has no recorded anchor" path into the
  // non-interactive default (b) WARN (nonInteractive's isInteractive:false), never reaching
  // sshKeygen/probeSshAuth (so ordinary init tests never shell out to a real `ssh-keygen`/`ssh`,
  // or touch the network). Tests exercising provisioning itself pass `[]`. `key` (the registered
  // public-key content) is optional per entry — round 2's reconcile cross-check (R3-1) needs it
  // set to the SAME content the test's own sshKeygen/pre-seeded `.pub` file carries for a green
  // reconcile; omitted entries have no `key` field at all (mirrors a real `gh` response that
  // wasn't asked for it, or an unrelated/foreign key this test doesn't care to model precisely).
  deployKeyEntries?: { id: number; title: string; key?: string }[];
  deployKeyAddError?: string;
  defaultBranch?: string; // "api repos/<owner>/<repo> --jq .default_branch"; unset -> "" -> branch-protection check is skipped entirely
  // #606 gate② round 2 (R3-5 i): when set, READING the default branch itself fails (distinct
  // from `defaultBranch` being empty/unset, which the real gh call could never actually produce
  // for an existing repo — this models the call throwing, not returning nothing).
  defaultBranchReadError?: string;
  branchProtected?: boolean; // "api repos/<owner>/<repo>/branches/<branch>/protection"
  // #606 gate② round 1 (P2-7): when set, the branch-protection call fails with this message
  // instead of the default "confirmed unprotected" 404 shape — models a cannot-verify condition
  // (403/plan-limit/network/anything else that isn't a parseable 404).
  branchProtectionUnverifiableError?: string;
  // #606 gate② round 2 (R3-5 ii): the response for `repos/<owner>/<repo>/rules/branches/<branch>`
  // — only ever queried after the legacy protection endpoint 404s. Defaults to `[]` (no ruleset
  // covers the branch, so the legacy 404 stands as confirmed-unprotected). A non-empty array
  // means a ruleset protects it instead.
  rulesetEntries?: unknown[];
  // #606 gate② round 2 (R3-5 ii): when set, the ruleset-read call itself fails — the
  // cannot-verify WARN, not "confirmed unprotected", even though the legacy endpoint 404'd.
  rulesetReadError?: string;
}) {
  const calls: string[][] = [];
  // #606 gate② round 1: MUTABLE — a successful `gh repo deploy-key add` appends to this list, so
  // a subsequent list call (e.g. the read-back-the-new-id step) sees it. Ids are assigned
  // deterministically (max existing + 1, or 1 for the first key) rather than randomly, so tests
  // can assert on the exact id written into config.
  const keys: { id: number; title: string; key?: string }[] = [...(opts.deployKeyEntries ?? [{ id: 1, title: "sapwood-worker" }])];
  const run: GhRunner = async (args) => {
    calls.push(args);
    // #606 gate② round 1 (P1-1): pin the invalid argv dead — `--jq` on a "list"-style gh command
    // (NOT `gh api`, which needs no `--json` since its whole HTTP response already IS the JSON
    // being filtered) requires an explicit `--json <fields>` selection first; a live probe on
    // this repo confirmed `gh repo deploy-key list --jq ...` alone fails "cannot use --jq without
    // specifying --json". Reject here so the invalid form can never go green again.
    if (args[0] !== "api" && args.includes("--jq") && !args.includes("--json")) {
      throw new Error(`fakeRun: invalid argv — --jq without --json is rejected by gh for a non-'api' command: ${args.join(" ")}`);
    }
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
      return JSON.stringify(keys);
    }
    if (args[0] === "repo" && args[1] === "deploy-key" && args[2] === "add") {
      if (opts.deployKeyAddError) throw new Error(opts.deployKeyAddError);
      const titleIdx = args.indexOf("--title");
      const title = titleIdx !== -1 ? (args[titleIdx + 1] ?? "unknown") : "unknown";
      const newId = keys.length > 0 ? Math.max(...keys.map((k) => k.id)) + 1 : 1;
      keys.push({ id: newId, title });
      return "";
    }
    if (args[0] === "api" && args.includes("--jq") && args.includes(".default_branch")) {
      if (opts.defaultBranchReadError) throw new Error(opts.defaultBranchReadError);
      return opts.defaultBranch ?? "";
    }
    if (args[0] === "api" && /\/branches\/[^/]+\/protection$/.test(args[1] ?? "")) {
      if (opts.branchProtectionUnverifiableError) throw new Error(opts.branchProtectionUnverifiableError);
      if (!opts.branchProtected)
        throw new Error(`HTTP 404: Branch not protected (https://api.github.com/repos/x/x/branches/main/protection)`);
      return "{}";
    }
    if (args[0] === "api" && /\/rules\/branches\/[^/]+$/.test(args[1] ?? "")) {
      if (opts.rulesetReadError) throw new Error(opts.rulesetReadError);
      return JSON.stringify(opts.rulesetEntries ?? []);
    }
    return "";
  };
  return { run, calls };
}

// #606 gate② round 2 (R3-1): a fixed, real-shaped ed25519 public-key line, shared by every test
// that needs the LOCAL `.pub` file content to match a fakeRun deployKeyEntries' `key` field for
// a green reconcile (reconcileDeployKey's own content cross-check). writeFakeKeyPair writes both
// halves of a keypair at `path` with this content — the private half's own bytes are never
// inspected by anything under test, only the `.pub` file's.
const FAKE_PUB_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBogusFakeTestKeyMaterialOnly test-key";
function writeFakeKeyPair(path: string, pub: string = FAKE_PUB_KEY): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "fake-private-key-material");
  writeFileSync(`${path}.pub`, `${pub}\n`);
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
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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
    await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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
    await init(customCfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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
    await init(loadedCfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init creates missing labels and provisions a missing board lane", async () => {
  const { run, calls } = fakeRun({ labels: ["type:feature"], boardExists: true, boardOptions: ["In Progress", "Done"] });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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
      () => init(customCfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive }),
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
    await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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
    const { actions } = await init(cfgMs, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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

    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });

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
    await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
    const goalPath = join(dir, "docs", "PLAN.md");
    const firstWrite = readFileSync(goalPath, "utf8");

    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });

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
    const { actions } = await init(customCfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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

test("default issue-template paths resolve to four readable shipped files with anchored language-free plan sections", () => {
  for (const name of ISSUE_TEMPLATE_NAMES) {
    const path = defaultIssueTemplatePath(name);
    assert.ok(existsSync(path), `expected shipped issue template at ${path}`);
    const text = readFileSync(path, "utf8");
    assert.match(text, /^---\nname:/);
    assert.match(text, /^## Why$/m);
    assert.match(text, /^## What$/m);
    assert.match(text, /^Out of scope:/m);
    assert.match(text, /^## Acceptance criteria$/m);
    assert.match(text, /^<!-- sapwood:ac -->$/m);
    assert.match(text, /^- \[ \]/m);
    assert.match(text, /^## Verification plan$/m);
    assert.match(text, /^<!-- sapwood:verification -->$/m);
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
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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

    const first = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
    assert.deepEqual(readFileSync(existingPath), userContent);
    assert.ok(first.actions.some((action) => action === `issue template already present (${existingPath})`));

    const second = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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

test("defaultDoctrineTemplatePath resolves to a real, readable shipped file that never leaks sapwood's own internal engine rules/source symbols into the generic starter template", () => {
  const path = defaultDoctrineTemplatePath();
  assert.ok(existsSync(path), `expected shipped template at ${path}`);
  const text = readFileSync(path, "utf8");
  assert.doesNotMatch(
    text,
    /disabled-consumer rule/i,
    "sapwood's own internal engine rule must not leak into the generic starter template",
  );
  assert.doesNotMatch(
    text,
    /\btick\(\)|supervisor\.resume\(\)/,
    "sapwood's own source symbols must not leak into the generic starter template",
  );
});

test("init scaffolds the doctrine-file template when the resolved path is missing", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Ready", "In Progress", "Done"],
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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

    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });

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
    await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
    const doctrinePath = join(dir, "docs", "REVIEW-DOCTRINE.md");
    const firstWrite = readFileSync(doctrinePath, "utf8");

    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });

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
    const { actions } = await init(customCfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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
    const { actions } = await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
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

// ── #606 gate② round 1 (OWNER RULING, supersedes the title-only design): L1 scoped-worker-
//    identity deploy-key provisioning, anchored on the local (deployKeyPath, deployKeyId) pair ──

test("parseDeployKeys: parses the --json id,title array; malformed/non-array JSON degrades to empty, never throws", () => {
  assert.deepEqual(
    parseDeployKeys(
      JSON.stringify([
        { id: 1, title: "sapwood-worker" },
        { id: 2, title: "other-key" },
      ]),
    ),
    [
      { id: 1, title: "sapwood-worker" },
      { id: 2, title: "other-key" },
    ],
  );
  assert.deepEqual(parseDeployKeys("[]"), []);
  assert.deepEqual(parseDeployKeys("not json"), []);
  assert.deepEqual(parseDeployKeys(JSON.stringify({ not: "an array" })), []);
  // an entry missing id or title (unexpected gh output shape) is dropped, not half-adopted.
  assert.deepEqual(parseDeployKeys(JSON.stringify([{ id: 1, title: "ok" }, { title: "no id" }, { id: 2 }])), [{ id: 1, title: "ok" }]);
});

test("sanitizeHostnameForKeyTitle: lowercases, collapses non-alnum runs to a single dash, trims edges; an all-symbol name falls back to 'host'", () => {
  assert.equal(sanitizeHostnameForKeyTitle("MacBook-Pro.local"), "macbook-pro-local");
  assert.equal(sanitizeHostnameForKeyTitle("  weird__host!!  "), "weird-host");
  assert.equal(sanitizeHostnameForKeyTitle("***"), "host");
  assert.equal(sanitizeHostnameForKeyTitle("plain-host"), "plain-host");
});

test("writeDeployKeyConfigIntoYaml: writes BOTH deployKeyPath and deployKeyId right after the top-level worker: key, preserving every existing line/comment byte-for-byte", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const original =
      "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n\nworker:\n  model: opus # a real comment\n  effort: high\n";
    writeFileSync(cfgPath, original);
    const actions = writeDeployKeyConfigIntoYaml(cfgPath, "data/worker-deploy-key", 159210179);
    assert.ok(actions.some((a) => /wrote worker\.deployKeyPath\/worker\.deployKeyId/.test(a)));
    const after = readFileSync(cfgPath, "utf8");
    assert.match(after, /^worker:\n {2}deployKeyPath: data\/worker-deploy-key/m);
    assert.match(after, /^ {2}deployKeyId: 159210179$/m);
    for (const line of original.split("\n")) {
      if (line.length > 0) assert.ok(after.includes(line), `original line lost: ${line}`);
    }
    const reparsed = parseConfig(after);
    assert.equal(reparsed.worker.deployKeyPath, "data/worker-deploy-key");
    assert.equal(reparsed.worker.deployKeyId, 159210179);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDeployKeyConfigIntoYaml (P2-8 i): a top-level worker: line WITH a trailing comment is recognized too, not just the bare 'worker:'", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n\nworker: # worker settings\n  model: opus\n");
    writeDeployKeyConfigIntoYaml(cfgPath, "data/worker-deploy-key", 1);
    const after = readFileSync(cfgPath, "utf8");
    assert.match(after, /^worker: # worker settings\n {2}deployKeyPath: data\/worker-deploy-key/m);
    assert.equal(parseConfig(after).worker.deployKeyId, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDeployKeyConfigIntoYaml: no top-level worker: key -> appends a fresh worker: block at EOF", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(cfgPath, "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n");
    writeDeployKeyConfigIntoYaml(cfgPath, "data/worker-deploy-key", 42);
    const after = readFileSync(cfgPath, "utf8");
    assert.match(after, /\nworker:\n {2}deployKeyPath: data\/worker-deploy-key/);
    const parsed = parseConfig(after);
    assert.equal(parsed.worker.deployKeyPath, "data/worker-deploy-key");
    assert.equal(parsed.worker.deployKeyId, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDeployKeyConfigIntoYaml: REPLACES a prior deployKeyPath:/deployKeyId: pair (however indented) rather than leaving a stale second copy alongside the new one", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const original =
      "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\nworker:\n  deployKeyPath: some/stale/path\n  deployKeyId: 1\n";
    writeFileSync(cfgPath, original);
    writeDeployKeyConfigIntoYaml(cfgPath, "data/worker-deploy-key-fresh", 999);
    const after = readFileSync(cfgPath, "utf8");
    assert.doesNotMatch(after, /some\/stale\/path/);
    assert.doesNotMatch(after, /deployKeyId: 1$/m);
    const parsed = parseConfig(after);
    assert.equal(parsed.worker.deployKeyPath, "data/worker-deploy-key-fresh");
    assert.equal(parsed.worker.deployKeyId, 999);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDeployKeyConfigIntoYaml (P2-8 ii): a flow-style 'worker: { ... }' mapping is NEVER edited — returns a hand-edit WARN, file untouched", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const original = "board: { owner: acme, repo: widgets, projectNumber: 7 }\nworker: { model: opus, effort: high }\n";
    writeFileSync(cfgPath, original);
    const actions = writeDeployKeyConfigIntoYaml(cfgPath, "data/worker-deploy-key", 1);
    assert.ok(actions.some((a) => /NOT written/.test(a) && /flow-style/.test(a)));
    assert.equal(readFileSync(cfgPath, "utf8"), original, "byte-for-byte untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDeployKeyConfigIntoYaml (P2-8 iii): if the written value doesn't round-trip back to what was written, the ORIGINAL bytes are restored and a hand-edit WARN is returned — never a corrupted config", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const original = "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n\nworker:\n  model: opus\n";
    writeFileSync(cfgPath, original);
    // "null" is a YAML-special plain-scalar token — written UNQUOTED it round-trips back as the
    // null VALUE, not the string "null", so the written config fails z.string() validation (a
    // realistic hand-edit-adjacent failure mode, not a contrived schema violation): this exercises
    // the read-back-and-restore path exactly as a genuinely surprising path value would in
    // production.
    const actions = writeDeployKeyConfigIntoYaml(cfgPath, "null", 1);
    assert.ok(actions.some((a) => /NOT written/.test(a) && /did not parse back cleanly/.test(a)));
    assert.equal(readFileSync(cfgPath, "utf8"), original, "byte-for-byte restored to the original — never left corrupted");
    // The restored file must ALWAYS still parse as valid config.
    assert.doesNotThrow(() => parseConfig(readFileSync(cfgPath, "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearDeployKeyConfigFromYaml: removes both deployKeyPath: and deployKeyId: lines, preserving everything else; a no-op when neither is present", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    writeFileSync(
      cfgPath,
      "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\nworker:\n  model: opus\n  deployKeyPath: data/worker-deploy-key\n  deployKeyId: 42\n",
    );
    const actions = clearDeployKeyConfigFromYaml(cfgPath);
    assert.ok(actions.some((a) => /cleared/.test(a)));
    const after = readFileSync(cfgPath, "utf8");
    assert.doesNotMatch(after, /deployKeyPath:/);
    assert.doesNotMatch(after, /deployKeyId:/);
    assert.match(after, /model: opus/);
    const parsed = parseConfig(after);
    assert.equal(parsed.worker.deployKeyPath, undefined);
    assert.equal(parsed.worker.deployKeyId, undefined);

    const noop = clearDeployKeyConfigFromYaml(cfgPath);
    assert.deepEqual(noop, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #606 gate② round 2 (R3-4): a deployKeyPath:/deployKeyId:-shaped line sitting inside an
// UNRELATED block scalar elsewhere in the file must survive both writeDeployKeyConfigIntoYaml
// and clearDeployKeyConfigFromYaml untouched — both the presence-check and the strip filter are
// scoped to the top-level worker: block's own body only. Hosted under goal.file (a real,
// schema-valid `z.string()` field that accepts any block-scalar content) rather than a
// fabricated top-level key, so this fixture is itself schema-valid config, not merely
// YAML-syntax-valid.
const BLOCK_SCALAR_DECOY = "goal:\n  file: |\n    deployKeyPath: not a real key, just decoy prose\n    deployKeyId: 999999\n";

test("writeDeployKeyConfigIntoYaml (R3-4 block-scalar reproduction): a deployKeyPath:/deployKeyId:-shaped line inside an unrelated block scalar survives untouched; only the worker: block's own body is edited", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const original = `board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n${BLOCK_SCALAR_DECOY}worker:\n  model: opus\n`;
    writeFileSync(cfgPath, original);
    writeDeployKeyConfigIntoYaml(cfgPath, "data/worker-deploy-key", 1);
    const after = readFileSync(cfgPath, "utf8");
    // the decoy lines inside notes: | survive byte-for-byte
    assert.ok(
      after.includes("    deployKeyPath: not a real key, just decoy prose"),
      "decoy deployKeyPath: line inside goal.file's block scalar must survive",
    );
    assert.ok(after.includes("    deployKeyId: 999999"), "decoy deployKeyId: line inside goal.file's block scalar must survive");
    // the REAL anchor landed under the actual worker: block
    assert.match(after, /^worker:\n {2}deployKeyPath: data\/worker-deploy-key/m);
    const parsed = parseConfig(after);
    assert.equal(parsed.worker.deployKeyPath, "data/worker-deploy-key");
    assert.equal(parsed.worker.deployKeyId, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearDeployKeyConfigFromYaml (R3-4 block-scalar reproduction): a deployKeyPath:/deployKeyId:-shaped line inside an unrelated block scalar survives untouched while the worker: block's own anchor is cleared", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const original = `board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n${BLOCK_SCALAR_DECOY}worker:\n  deployKeyPath: data/worker-deploy-key\n  deployKeyId: 42\n`;
    writeFileSync(cfgPath, original);
    const actions = clearDeployKeyConfigFromYaml(cfgPath);
    assert.ok(actions.some((a) => /cleared/.test(a)));
    const after = readFileSync(cfgPath, "utf8");
    assert.ok(
      after.includes("    deployKeyPath: not a real key, just decoy prose"),
      "decoy line inside goal.file's block scalar must survive the clear",
    );
    assert.ok(after.includes("    deployKeyId: 999999"), "decoy line inside goal.file's block scalar must survive the clear");
    const parsed = parseConfig(after);
    assert.equal(parsed.worker.deployKeyPath, undefined);
    assert.equal(parsed.worker.deployKeyId, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearDeployKeyConfigFromYaml (R3-4): a deployKeyPath:/deployKeyId:-shaped decoy line BEFORE any real top-level worker: block is never mistaken for presence — a file with ONLY the decoy is a correct no-op", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    // no top-level `worker:` block at all — just the decoy inside notes: |
    const original = `board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\n${BLOCK_SCALAR_DECOY}`;
    writeFileSync(cfgPath, original);
    const actions = clearDeployKeyConfigFromYaml(cfgPath);
    assert.deepEqual(actions, [], "no worker: block exists, so there is nothing this function can (or should) clear");
    assert.equal(readFileSync(cfgPath, "utf8"), original, "byte-for-byte untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #606 gate② round 3 (item 2): a block scalar NESTED INSIDE the worker: block itself — e.g.
// worker.promptFile: | — sits at a DEEPER indent than the block's own direct children
// (deployKeyPath:/deployKeyId: at 2 spaces; the block-scalar body at 4+). The round-2 fix scoped
// matching to "inside the worker: block", but not to "at the block's own direct-child indent",
// so a schema-valid worker.promptFile whose CONTENT happens to contain the literal text
// "deployKeyPath: ..."/"deployKeyId: ..." was still silently emptied by both write and clear.
const NESTED_PROMPT_DECOY =
  "  promptFile: |\n    deployKeyPath: this is prose INSIDE the prompt file text, not a real config key\n    deployKeyId: 4242 (also prose)\n";

test("writeDeployKeyConfigIntoYaml (gate② round 3, item 2a): a block scalar under worker.promptFile containing deployKeyPath:/deployKeyId:-shaped text survives write byte-for-byte; only the REAL direct-child anchor lines are inserted", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const original = `board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\nworker:\n${NESTED_PROMPT_DECOY}  model: opus\n`;
    writeFileSync(cfgPath, original);
    writeDeployKeyConfigIntoYaml(cfgPath, "data/worker-deploy-key", 1);
    const after = readFileSync(cfgPath, "utf8");
    // the nested block-scalar prose survives byte-for-byte, untouched
    assert.ok(
      after.includes("    deployKeyPath: this is prose INSIDE the prompt file text, not a real config key"),
      "the nested promptFile block-scalar line must survive",
    );
    assert.ok(after.includes("    deployKeyId: 4242 (also prose)"), "the nested promptFile block-scalar line must survive");
    // the REAL anchor landed as a direct child of worker: (2-space indent)
    assert.match(after, /^worker:\n {2}deployKeyPath: data\/worker-deploy-key/m);
    const parsed = parseConfig(after);
    assert.equal(parsed.worker.deployKeyPath, "data/worker-deploy-key");
    assert.equal(parsed.worker.deployKeyId, 1);
    assert.ok(parsed.worker.promptFile?.includes("deployKeyPath: this is prose"), "worker.promptFile's own content is preserved verbatim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearDeployKeyConfigFromYaml (gate② round 3, item 2a): a block scalar under worker.promptFile containing deployKeyPath:/deployKeyId:-shaped text survives clear byte-for-byte; only the REAL direct-child anchor lines are removed", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const original = `board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\nworker:\n  deployKeyPath: data/worker-deploy-key\n  deployKeyId: 42\n${NESTED_PROMPT_DECOY}  model: opus\n`;
    writeFileSync(cfgPath, original);
    const actions = clearDeployKeyConfigFromYaml(cfgPath);
    assert.ok(actions.some((a) => /cleared/.test(a)));
    const after = readFileSync(cfgPath, "utf8");
    assert.ok(
      after.includes("    deployKeyPath: this is prose INSIDE the prompt file text, not a real config key"),
      "the nested promptFile block-scalar line must survive the clear",
    );
    assert.ok(after.includes("    deployKeyId: 4242 (also prose)"), "the nested promptFile block-scalar line must survive the clear");
    assert.ok(after.includes("  model: opus"), "sibling direct-child content survives");
    const parsed = parseConfig(after);
    assert.equal(parsed.worker.deployKeyPath, undefined);
    assert.equal(parsed.worker.deployKeyId, undefined);
    assert.ok(parsed.worker.promptFile?.includes("deployKeyPath: this is prose"), "worker.promptFile's own content is preserved verbatim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearDeployKeyConfigFromYaml (gate② round 3, item 2b): a BLANK LINE between deployKeyId: and the next direct child (e.g. model:) does not cause a false 'nothing left' — the block's own header survives and the sibling child is preserved", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const original =
      "board:\n  owner: acme\n  repo: widgets\n  projectNumber: 7\nworker:\n  deployKeyPath: data/worker-deploy-key\n  deployKeyId: 42\n\n  model: opus\n";
    writeFileSync(cfgPath, original);
    const actions = clearDeployKeyConfigFromYaml(cfgPath);
    assert.ok(actions.some((a) => /cleared/.test(a)));
    const after = readFileSync(cfgPath, "utf8");
    assert.doesNotMatch(after, /deployKeyPath:/);
    assert.doesNotMatch(after, /deployKeyId:/);
    assert.match(after, /^worker:/m, "the worker: header must survive — model: opus is a real remaining child");
    assert.match(after, /model: opus/);
    const parsed = parseConfig(after);
    assert.equal(parsed.worker.deployKeyPath, undefined);
    assert.equal(parsed.worker.deployKeyId, undefined);
    assert.equal(parsed.worker.model, "opus");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pickFreshArmAKeySlot: the bare hostComponent slot when both the local path and the title are free", () => {
  const dir = tmpCwd();
  try {
    const slot = pickFreshArmAKeySlot(dir, "myhost", new Set());
    assert.equal(slot.path, join(dir, "data", "worker-deploy-key-myhost"));
    assert.equal(slot.title, "sapwood-worker-myhost");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pickFreshArmAKeySlot (R3-1): a LOCAL path collision skips to the next numeric suffix, even when the base title is free remotely", () => {
  const dir = tmpCwd();
  try {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "worker-deploy-key-myhost"), "leftover from a previous interrupted run");
    const slot = pickFreshArmAKeySlot(dir, "myhost", new Set());
    assert.equal(slot.path, join(dir, "data", "worker-deploy-key-myhost-2"));
    assert.equal(slot.title, "sapwood-worker-myhost-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pickFreshArmAKeySlot (R3-1): a REMOTE title collision skips to the next numeric suffix, even when the local path is free — an already-registered per-host title is treated as foreign, never reused", () => {
  const dir = tmpCwd();
  try {
    const slot = pickFreshArmAKeySlot(dir, "myhost", new Set(["sapwood-worker-myhost"]));
    assert.equal(slot.path, join(dir, "data", "worker-deploy-key-myhost-2"));
    assert.equal(slot.title, "sapwood-worker-myhost-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pickFreshArmAKeySlot (R3-1): path AND title suffixes always move together — a collision on -2 (either dimension) advances to -3", () => {
  const dir = tmpCwd();
  try {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "worker-deploy-key-myhost"), "x");
    writeFileSync(join(dir, "data", "worker-deploy-key-myhost-2"), "x");
    const slot = pickFreshArmAKeySlot(dir, "myhost", new Set(["sapwood-worker-myhost", "sapwood-worker-myhost-2"]));
    assert.equal(slot.path, join(dir, "data", "worker-deploy-key-myhost-3"));
    assert.equal(slot.title, "sapwood-worker-myhost-3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pickFreshArmAKeySlot (gate② round 3, item 3): every candidate title already taken -> THROWS (no Date.now()-derived fallback that could silently collide with an unchecked slot)", () => {
  const dir = tmpCwd();
  try {
    const allTaken = new Set(
      Array.from({ length: 1000 }, (_, i) => (i === 0 ? "sapwood-worker-myhost" : `sapwood-worker-myhost-${i + 1}`)),
    );
    assert.throws(() => pickFreshArmAKeySlot(dir, "myhost", allTaken), /could not find a free per-machine deploy-key slot/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearDeployKeyConfigFromJson (R3-2): removes worker.deployKeyPath/deployKeyId, preserving other worker keys and top-level keys; drops the worker object entirely once empty", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        board: { owner: "acme", repo: "widgets", projectNumber: 7 },
        worker: { deployKeyPath: "data/worker-deploy-key", deployKeyId: 42 },
      }),
    );
    const actions = clearDeployKeyConfigFromJson(cfgPath);
    assert.ok(actions.some((a) => /cleared/.test(a)));
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.equal(parsed.worker, undefined, "an empty worker object is dropped entirely, not left as {}");
    assert.equal(parsed.board.owner, "acme", "unrelated top-level content survives");
    const reparsed = parseConfig(readFileSync(cfgPath, "utf8"));
    assert.equal(reparsed.worker.deployKeyPath, undefined);
    assert.equal(reparsed.worker.deployKeyId, undefined);

    const noop = clearDeployKeyConfigFromJson(cfgPath);
    assert.deepEqual(noop, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearDeployKeyConfigFromJson (R3-2): preserves sibling worker keys — only deployKeyPath/deployKeyId are removed", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        board: { owner: "acme", repo: "widgets", projectNumber: 7 },
        worker: { model: "opus", deployKeyPath: "data/worker-deploy-key", deployKeyId: 42 },
      }),
    );
    clearDeployKeyConfigFromJson(cfgPath);
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.equal(parsed.worker.model, "opus");
    assert.equal(parsed.worker.deployKeyPath, undefined);
    assert.equal(parsed.worker.deployKeyId, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearDeployKeyConfigFromJson: malformed JSON -> a hand-edit WARN, file untouched", () => {
  const dir = tmpCwd();
  try {
    const cfgPath = join(dir, "sapwood.config.json");
    const original = "{ not valid json,,,";
    writeFileSync(cfgPath, original);
    const actions = clearDeployKeyConfigFromJson(cfgPath);
    assert.ok(actions.some((a) => /NOT cleared/.test(a)));
    assert.equal(readFileSync(cfgPath, "utf8"), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const cfgKeyPath = (dir: string) => join(dir, "data", "worker-deploy-key");

test("init: a fresh fixture repo receives a starter config pinned to produce-pr-and-stop", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((label) => label.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
  });
  const dir = tmpCwd();
  try {
    await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: failSshKeygen,
      probeSshAuth: failProbeSshAuth,
    });

    const starter = readFileSync(join(dir, "sapwood.config.yaml"), "utf8");
    assert.equal(parseConfig(starter).merge.mode, "produce-pr-and-stop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #801: `sapwood init` scaffolds a config pairing reviewer.mode: engine-agent (#501 default)
// with NO ci.requiredChecks — the exact shape `sapwood run` hard-refuses at startup (#784). The
// scaffold is deliberately NOT given a guessed check name (see init.ts's own comment on why that
// would be worse — a wrong name would silently reintroduce the queue-forever foot-gun one layer
// deeper), so this smoke test pins the alternative the issue's AC accepts: init's own output
// warns explicitly, BEFORE the operator ever reaches `run`, and that warning is not a guess —
// `sapwood run` on the EXACT scaffold init just wrote refuses with the identical predicate
// (engineAgentEmptyCiRequiredChecksError, #784/#801), so there is no gap between what init said
// and what `run` actually does. The init→run path is never a silent cliff.
test("init→run smoke (#801): sapwood init warns about its own scaffold's engine-agent + empty ci.requiredChecks combination, and sapwood run on that exact scaffold refuses with the SAME predicate — no undisclosed cliff", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((label) => label.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: failSshKeygen,
      probeSshAuth: failProbeSshAuth,
    });

    // init told the operator, in its own printed action list, before they ever ran `sapwood run`.
    const warning = actions.find((a) => a.startsWith("config: WARN"));
    assert.ok(warning, "init must warn about the engine-agent + empty ci.requiredChecks scaffold");
    assert.match(warning!, /reviewer\.mode is "engine-agent"/);
    assert.match(warning!, /ci\.requiredChecks is empty/);

    const starterPath = join(dir, "sapwood.config.yaml");
    const starterCfg = parseConfig(readFileSync(starterPath, "utf8"));
    // The scaffold itself reproduces exactly the combination the warning named — proving the
    // warning wasn't testing a DIFFERENT config than what actually landed on disk.
    assert.ok(engineAgentEmptyCiRequiredChecksError(starterCfg));

    // `sapwood run` against that EXACT file refuses at startup — ZERO forge/dispatch work, same
    // as cli-rounds.test.ts's own #784 smoke test — with the identical message init already
    // showed the operator, never a surprise second failure mode. Same stderr-capture shape as
    // cli-rounds.test.ts's own (unexported, so duplicated here) captureStderr helper.
    const state = new State(":memory:");
    try {
      const originalWrite = process.stderr.write.bind(process.stderr);
      let stderr = "";
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        stderr += chunk.toString();
        return true;
      }) as typeof process.stderr.write;
      let code: number;
      try {
        code = await runEngine(["node", "sapwood", "run", "--config", starterPath], { state, logger: { log() {} } });
      } finally {
        process.stderr.write = originalWrite;
      }
      assert.equal(code, 1);
      assert.match(stderr, /reviewer\.mode is "engine-agent"/);
      assert.match(stderr, /ci\.requiredChecks is empty/);
    } finally {
      state.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: FRESH PROVISIONING — nothing configured, no sapwood-titled remote key -> provisions end-to-end (ssh-keygen + gh repo deploy-key add --allow-write --title sapwood-worker), reads back the new id, preflight green, BOTH deployKeyPath and deployKeyId written into the config file, .gitignore covers the key", async () => {
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [], // nothing registered at all -> fresh provisioning runs
  });
  const dir = tmpCwd();
  try {
    let keygenCalledWith: string | undefined;
    let probeCalledWith: string | undefined;
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
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
    const expectedKeyPath = cfgKeyPath(dir);
    assert.equal(keygenCalledWith, expectedKeyPath);
    assert.equal(probeCalledWith, expectedKeyPath);
    const listCalls = calls.filter((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "list");
    assert.ok(
      listCalls.every((c) => c.includes("--json") && c.includes("id,title") && !c.includes("--jq")),
      "every deploy-key list call uses --json id,title, never the invalid --jq-only form",
    );
    const addCall = calls.find((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add");
    assert.ok(addCall, "gh repo deploy-key add must be called");
    assert.ok(addCall!.includes("--allow-write"));
    assert.equal(addCall![addCall!.indexOf("--title") + 1], "sapwood-worker");
    assert.equal(addCall![3], `${expectedKeyPath}.pub`);
    assert.ok(actions.some((a) => /added write deploy key/.test(a)));
    assert.ok(actions.some((a) => /preflight OK/.test(a)));
    assert.ok(actions.some((a) => /wrote worker\.deployKeyPath\/worker\.deployKeyId/.test(a)));
    assert.ok(
      actions.some((a) => /appended "\/data\/worker-deploy-key\*" as the last rule/.test(a)),
      "gitignore guarantee action reported",
    );
    const configPath = join(dir, "sapwood.config.yaml");
    const configText = readFileSync(configPath, "utf8");
    assert.match(configText, /deployKeyPath: data[/\\]worker-deploy-key/);
    assert.match(configText, /deployKeyId: 1\b/); // fakeRun's fresh deploy-key add is read back as id 1 (see below)
    const reparsed = parseConfig(configText);
    assert.equal(reparsed.worker.deployKeyPath, join("data", "worker-deploy-key"));
    assert.equal(reparsed.worker.deployKeyId, 1);
    // #606 gate② round 2 (R3-7): the exact rooted rule, as the FILE's LAST effective line —
    // gitignore is last-match-wins, so only its position at EOF (not merely "present somewhere")
    // guarantees it applies regardless of anything earlier in the file.
    const gitignoreLines = readFileSync(join(dir, ".gitignore"), "utf8").split("\n");
    const lastNonBlank = [...gitignoreLines].reverse().find((l) => l.trim().length > 0);
    assert.equal(lastNonBlank, "/data/worker-deploy-key*");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: RECONCILE — deployKeyPath+deployKeyId both configured, local file exists, id listed, preflight green -> a positive confirmation action, NO re-provisioning (no ssh-keygen, no deploy-key add, no config rewrite)", async () => {
  const dir = tmpCwd();
  // #606 gate② round 1: deployKeyPath must be ABSOLUTE here — production's loadConfig() always
  // resolves a relative worker.deployKeyPath against the config file's directory before init()
  // ever sees it (config.ts's own #606 rule), so reconcileDeployKey's existsSync check assumes
  // an already-resolved path. parseConfig() alone (used by this fixture, unlike loadConfig)
  // does NOT do that resolution — a bare relative string here would check the wrong path
  // (relative to the TEST RUNNER's cwd, not `dir`), so this fixture inlines the absolute path
  // directly, exactly what a real loadConfig()'d cfg would already carry.
  const keyPath = cfgKeyPath(dir);
  const provisioned = parseConfig(
    `board: { owner: acme, repo: widgets, projectNumber: 7 }\nworker: { deployKeyPath: ${keyPath}, deployKeyId: 159210179 }`,
  );
  const { run, calls } = fakeRun({
    labels: requiredLabels(provisioned).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    // #606 gate② round 2 (R3-1): the id-matched entry's `key` must match the LOCAL `.pub` file
    // content below for reconcile's cross-check to go green — an id merely being "listed" is no
    // longer sufficient on its own.
    deployKeyEntries: [{ id: 159210179, title: "sapwood-worker", key: FAKE_PUB_KEY }],
  });
  try {
    writeFakeKeyPair(keyPath);
    const configPath = join(dir, "sapwood.config.yaml");
    writeFileSync(
      configPath,
      `board: { owner: acme, repo: widgets, projectNumber: 7 }\nworker: { deployKeyPath: ${keyPath}, deployKeyId: 159210179 }\n`,
    );
    const before = readFileSync(configPath, "utf8");
    const { actions } = await init(provisioned, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: failSshKeygen,
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.ok(!calls.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add"), "no re-provisioning on a clean reconcile");
    assert.ok(actions.some((a) => /reconciled/.test(a) && /L1 active/.test(a)));
    assert.equal(readFileSync(configPath, "utf8"), before, "config untouched on a clean reconcile");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (P1-5): RECONCILE FAILS (recorded id no longer listed — rotated/stale) -> non-interactive default (b): WARN + config anchor CLEARED, remote NEVER touched (no deploy-key delete call, ever)", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir); // see the RECONCILE test above for why this must be absolute
  const provisioned = parseConfig(
    `board: { owner: acme, repo: widgets, projectNumber: 7 }\nworker: { deployKeyPath: ${keyPath}, deployKeyId: 9999999 }`,
  );
  const { run, calls } = fakeRun({
    labels: requiredLabels(provisioned).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    // the recorded id (9999999) is NOT in this list — a different id is registered instead,
    // modeling a rotated/foreign key under the same shared title.
    deployKeyEntries: [{ id: 42, title: "sapwood-worker" }],
  });
  try {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(keyPath, "stale-private-key");
    const configPath = join(dir, "sapwood.config.yaml");
    writeFileSync(
      configPath,
      `board: { owner: acme, repo: widgets, projectNumber: 7 }\nworker:\n  deployKeyPath: ${keyPath}\n  deployKeyId: 9999999\n`,
    );
    const { actions } = await init(provisioned, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: failSshKeygen,
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.ok(!calls.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add"), "arm (b) never registers a key");
    assert.ok(
      !calls.some((c) => c.join(" ").includes("delete")),
      "the remote key is NEVER deleted or modified — the owner ruling forbids it, including in this arm",
    );
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn, "expected a WARN action line");
    assert.match(warn!, /9999999/, "names the stale recorded id");
    assert.match(
      warn!,
      /sapwood-worker.*id 42/,
      "surfaces the foreign/stale remote key for HUMAN cleanup — behaviorally never touched (see the calls-log assertion above)",
    );
    const configText = readFileSync(configPath, "utf8");
    assert.doesNotMatch(
      configText,
      /deployKeyPath:/,
      "the stale local anchor is CLEARED — this is what makes 're-run init' converge (P1-5)",
    );
    assert.doesNotMatch(configText, /deployKeyId:/);
    // #606 gate② round 2 (R3-2): the file must no longer PARSE with the anchor either — not
    // just a text-level absence of the string "deployKeyPath:".
    assert.equal(parseConfig(configText).worker.deployKeyPath, undefined);
    assert.equal(parseConfig(configText).worker.deployKeyId, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (R3-1): RECONCILE FAILS when the recorded id IS listed and the local file DOES exist and SSH preflight succeeds, but the local .pub content does NOT match that id's own registered key — proves the (path, id) pair was never recorded together", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir); // absolute — see the RECONCILE test's own note on why
  const provisioned = parseConfig(
    `board: { owner: acme, repo: widgets, projectNumber: 7 }\nworker: { deployKeyPath: ${keyPath}, deployKeyId: 42 }`,
  );
  const { run, calls } = fakeRun({
    labels: requiredLabels(provisioned).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    // id 42 IS registered — but under a DIFFERENT public key than the one at `keyPath` below (a
    // hand-edited id, or an id that once matched but was rotated on the remote side without
    // updating the local anchor).
    deployKeyEntries: [{ id: 42, title: "sapwood-worker", key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAADifferentKeyEntirely unrelated" }],
  });
  const configPath = join(dir, "sapwood.config.yaml");
  writeFileSync(
    configPath,
    `board: { owner: acme, repo: widgets, projectNumber: 7 }\nworker:\n  deployKeyPath: ${keyPath}\n  deployKeyId: 42\n`,
  );
  try {
    writeFakeKeyPair(keyPath); // local .pub content is FAKE_PUB_KEY — does not match the entry's `key` above
    const { actions } = await init(provisioned, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: failSshKeygen,
      // the SSH transport-level preflight succeeds — GitHub's own auth doesn't reveal WHICH
      // registered key a probe authenticated as, only that SOME key on the repo matched.
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.ok(!calls.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add"), "arm (b) default never registers a key");
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn, "expected a WARN action line");
    assert.match(warn!, /does not match the public key registered under id 42/i);
    assert.match(warn!, /no longer refers to the same key/i);
    const reparsed = parseConfig(readFileSync(configPath, "utf8"));
    assert.equal(reparsed.worker.deployKeyPath, undefined, "the stale anchor is cleared");
    assert.equal(reparsed.worker.deployKeyId, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (P1-5 convergence AC): re-running init after a reconcile-fail state converges to a green reconcile once the operator fixes the local key file", async () => {
  const dir = tmpCwd();
  // NB: deliberately left relative here — round 1's whole point is that the local key file is
  // MISSING regardless (never created under either interpretation), triggering the reconcile
  // failure this test exercises.
  const configPath = join(dir, "sapwood.config.yaml");
  writeFileSync(
    configPath,
    "board: { owner: acme, repo: widgets, projectNumber: 7 }\nworker:\n  deployKeyPath: data/worker-deploy-key\n  deployKeyId: 42\n",
  );
  try {
    // Round 1: local key file MISSING -> reconcile fails -> arm (b) -> config cleared.
    const cfg1 = parseConfig(readFileSync(configPath, "utf8"));
    const { run: run1 } = fakeRun({
      labels: requiredLabels(cfg1).map((l) => l.name),
      boardExists: true,
      boardOptions: ["Todo", "Ready", "In Progress", "Done"],
      deployKeyEntries: [{ id: 42, title: "sapwood-worker" }],
    });
    const first = await init(cfg1, { run: run1, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
    assert.ok(first.actions.some((a) => a.startsWith("deploy key: WARN")));
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /deployKeyPath:/, "cleared after round 1's failed reconcile");

    // Round 2 ("re-run sapwood init"): config now has NEITHER field, and the OLD "sapwood-worker"-
    // titled key is STILL registered (never deleted) — this machine still has no recorded anchor
    // for it, so a non-interactive re-run would stay at the same honest WARN forever (correct,
    // safe default). The ruling's own convergence path is INTERACTIVE choice (a): "after choosing
    // (a), re-run init -> preflight green with the machine's own key" — modeled here.
    const cfg2 = parseConfig(readFileSync(configPath, "utf8"));
    const { run: run2, calls: calls2 } = fakeRun({
      labels: requiredLabels(cfg2).map((l) => l.name),
      boardExists: true,
      boardOptions: ["Todo", "Ready", "In Progress", "Done"],
      // the OLD foreign/stale key is still there (never deleted); provisioning adds a NEW,
      // per-machine-titled one alongside it.
      deployKeyEntries: [{ id: 42, title: "sapwood-worker" }],
    });
    const second = await init(cfg2, {
      run: run2,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      isInteractive: () => true,
      promptOperator: async () => "a",
      hostname: () => "converge-host",
      sshKeygen: async (path) => {
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    // Converges: a NEW per-machine key was added (the old one untouched), and the config now
    // carries a fresh (path, id) anchor for THIS machine's own key — the reconcile a THIRD run
    // would perform is green from here on.
    assert.ok(calls2.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add" && c.includes("sapwood-worker-converge-host")));
    assert.ok(!calls2.some((c) => c.join(" ").includes("delete")), "the old key is never deleted, even on the converging path");
    const finalConfig = parseConfig(readFileSync(configPath, "utf8"));
    assert.equal(finalConfig.worker.deployKeyPath, join("data", "worker-deploy-key-converge-host"));
    assert.equal(typeof finalConfig.worker.deployKeyId, "number");
    assert.ok(second.actions.some((a) => /SSH auth preflight OK/.test(a)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: nothing configured locally, but a sapwood-titled key ALREADY exists remotely (no recorded anchor for it) -> never assumed to be 'mine' — routed through the same WARN+choice arm, remote never touched", async () => {
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [{ id: 7, title: "sapwood-worker" }], // registered by SOME machine, unknown to this one
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: failSshKeygen,
      probeSshAuth: failProbeSshAuth,
    });
    assert.ok(!calls.some((c) => c.join(" ").includes("delete")));
    assert.ok(!calls.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add"), "arm (b) default never registers a key");
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn);
    assert.match(warn!, /no local \(path, id\) anchor/i);
    assert.match(warn!, /sapwood-worker.*id 7/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (arm (a), interactive): operator chooses (a) -> registers an ADDITIONAL per-machine key titled sapwood-worker-<hostname>, leaves the existing remote key untouched, records the NEW (path, id) in config", async () => {
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [{ id: 7, title: "sapwood-worker" }], // pre-existing, unowned-by-this-machine key
  });
  const dir = tmpCwd();
  try {
    let promptedWith: string | undefined;
    let keygenCalledWith: string | undefined;
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      isInteractive: () => true,
      promptOperator: async (q) => {
        promptedWith = q;
        return "a";
      },
      hostname: () => "MyLaptop.local",
      sshKeygen: async (path) => {
        keygenCalledWith = path;
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.ok(promptedWith, "the operator must be prompted when isInteractive() is true");
    const expectedTitle = "sapwood-worker-mylaptop-local";
    const expectedKeyPath = join(dir, "data", "worker-deploy-key-mylaptop-local");
    assert.equal(keygenCalledWith, expectedKeyPath);
    const addCall = calls.find((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add");
    assert.ok(addCall);
    assert.equal(addCall![addCall!.indexOf("--title") + 1], expectedTitle);
    assert.ok(!calls.some((c) => c.join(" ").includes("delete")), "the pre-existing remote key is left untouched, never deleted");
    assert.ok(actions.some((a) => a.includes(expectedTitle) && /operator chose \(a\)/.test(a)));
    const configText = readFileSync(join(dir, "sapwood.config.yaml"), "utf8");
    const reparsed = parseConfig(configText);
    assert.equal(reparsed.worker.deployKeyPath, join("data", "worker-deploy-key-mylaptop-local"));
    assert.equal(typeof reparsed.worker.deployKeyId, "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (arm (a), interactive, R3-1 non-reuse): a PRE-EXISTING sapwood-worker-<hostname> title on the repo is treated as foreign — arm (a) mints a numeric-suffixed sibling (path AND title) rather than reusing or colliding with it", async () => {
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    // this machine's OWN per-host title is already registered remotely — but this machine has
    // no LOCAL anchor for it (a fresh checkout, a wiped data dir, ...): per the ruling, a title
    // is never proof of ownership, so this is treated the same as any other foreign key.
    deployKeyEntries: [{ id: 11, title: "sapwood-worker-test-host" }],
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      isInteractive: () => true,
      promptOperator: async () => "a",
      hostname: () => "test-host",
      sshKeygen: async (path) => {
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    const expectedTitle = "sapwood-worker-test-host-2";
    const expectedKeyPath = join(dir, "data", "worker-deploy-key-test-host-2");
    const addCall = calls.find((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add");
    assert.ok(addCall, "gh repo deploy-key add must be called");
    assert.equal(
      addCall![3],
      `${expectedKeyPath}.pub`,
      "the FRESH keypair is minted at the suffixed sibling path, never the colliding one",
    );
    assert.equal(addCall![addCall!.indexOf("--title") + 1], expectedTitle);
    assert.ok(!calls.some((c) => c.join(" ").includes("delete")), "the pre-existing per-host-titled key is left untouched, never deleted");
    assert.ok(actions.some((a) => a.includes(expectedTitle)));
    const reparsed = parseConfig(readFileSync(join(dir, "sapwood.config.yaml"), "utf8"));
    assert.equal(reparsed.worker.deployKeyPath, join("data", "worker-deploy-key-test-host-2"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (gate② round 3, item 3): EVERY per-machine slot already occupied remotely -> the SAME provisioning-failure WARN path, no add call — no Date.now()-derived fallback that could silently collide", async () => {
  // One remote entry per candidate slot pickFreshArmAKeySlot would ever try for hostComponent
  // "test-host" (1..MAX_ARM_A_SLOT_ATTEMPTS, matching init.ts's own constant) — exhausts the walk.
  const blockingTitles = Array.from({ length: 1000 }, (_, i) => {
    const n = i + 1;
    const candidateHost = n === 1 ? "test-host" : `test-host-${n}`;
    return { id: n, title: `sapwood-worker-${candidateHost}` };
  });
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: blockingTitles,
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      isInteractive: () => true,
      promptOperator: async () => "a",
      hostname: () => "test-host",
      sshKeygen: failSshKeygen,
      probeSshAuth: failProbeSshAuth,
    });
    assert.ok(
      !calls.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add"),
      "no add call — exhaustion is caught before any registration is attempted",
    );
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn, "expected the ordinary provisioning-failure WARN");
    assert.match(warn!, /could not find a free per-machine deploy-key slot/i);
    assert.match(warn!, /1000 numeric-suffixed attempts/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (R3-1): a post-add id diff yielding ZERO new ids is treated as an ordinary provisioning failure (degrade (b)-style) — never silently adopts a wrong id", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
  });
  const dir = tmpCwd();
  try {
    // Wrap `run` so the deploy-key "add" call succeeds but is a pure no-op against the fake's
    // own key list — modeling a gh response that reports success without a new entry actually
    // appearing on the next list call.
    const noOpAddRun: GhRunner = async (args) => {
      if (args[0] === "repo" && args[1] === "deploy-key" && args[2] === "add") return "";
      return run(args);
    };
    const { actions } = await init(cfg, {
      run: noOpAddRun,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async (path) => {
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: failProbeSshAuth,
    });
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn, "expected the ordinary provisioning-failure WARN");
    assert.match(warn!, /no new id appeared/i);
    const configText = readFileSync(join(dir, "sapwood.config.yaml"), "utf8");
    assert.doesNotMatch(configText, /deployKeyPath:/, "no anchor written when the new id couldn't be determined");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (R3-1): a post-add id diff yielding MORE THAN ONE new id is treated as an ordinary provisioning failure (degrade (b)-style) — ambiguous, never guessed", async () => {
  const { run: baseRun } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
  });
  const dir = tmpCwd();
  try {
    let addCalled = false;
    // Wrap `run` so the deploy-key "add" call succeeds, but every list call AFTER it (the
    // after-list) reports TWO new entries — modeling a raced/duplicate provisioning.
    const racedRun: GhRunner = async (args) => {
      if (args[0] === "repo" && args[1] === "deploy-key" && args[2] === "add") {
        addCalled = true;
        return "";
      }
      if (addCalled && args[0] === "repo" && args[1] === "deploy-key" && args[2] === "list") {
        return JSON.stringify([
          { id: 1, title: "sapwood-worker" },
          { id: 2, title: "sapwood-worker" },
        ]);
      }
      return baseRun(args);
    };
    const { actions } = await init(cfg, {
      run: racedRun,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async (path) => {
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: failProbeSshAuth,
    });
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn, "expected the ordinary provisioning-failure WARN");
    assert.match(warn!, /2 new ids appeared/i);
    const configText = readFileSync(join(dir, "sapwood.config.yaml"), "utf8");
    assert.doesNotMatch(configText, /deployKeyPath:/, "no anchor written when the new id is ambiguous");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (arm (b), interactive, R3-2 YAML): starting from an ACTUALLY-configured stale (path, id) anchor, operator explicitly chooses (b) -> WARN, the file no longer PARSES with the anchor, nothing registered", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir); // absolute — see the RECONCILE test's own note on why
  const provisioned = parseConfig(
    `board: { owner: acme, repo: widgets, projectNumber: 7 }\nworker: { deployKeyPath: ${keyPath}, deployKeyId: 7 }`,
  );
  const { run, calls } = fakeRun({
    labels: requiredLabels(provisioned).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    // id 7 is registered, but under a DIFFERENT key than the local file (or the local file is
    // simply missing below) — reconcile fails regardless of which specific reason.
    deployKeyEntries: [{ id: 7, title: "sapwood-worker" }],
  });
  const configPath = join(dir, "sapwood.config.yaml");
  writeFileSync(
    configPath,
    `board: { owner: acme, repo: widgets, projectNumber: 7 }\nworker:\n  deployKeyPath: ${keyPath}\n  deployKeyId: 7\n`,
  );
  try {
    const { actions } = await init(provisioned, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      isInteractive: () => true,
      promptOperator: async () => "b",
      hostname: () => "host",
      sshKeygen: failSshKeygen,
      probeSshAuth: failProbeSshAuth,
    });
    assert.ok(!calls.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add"));
    assert.ok(!calls.some((c) => c.join(" ").includes("delete")));
    assert.ok(actions.some((a) => a.startsWith("deploy key: WARN")));
    const reparsed = parseConfig(readFileSync(configPath, "utf8"));
    assert.equal(reparsed.worker.deployKeyPath, undefined, "the file no longer PARSES with the anchor");
    assert.equal(reparsed.worker.deployKeyId, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (arm (b), interactive, R3-2 JSON): starting from an ACTUALLY-configured stale (path, id) anchor in a JSON config, operator explicitly chooses (b) -> WARN, the file no longer PARSES with the anchor", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir);
  const provisioned = parseConfig(
    JSON.stringify({ board: { owner: "acme", repo: "widgets", projectNumber: 7 }, worker: { deployKeyPath: keyPath, deployKeyId: 7 } }),
  );
  const { run, calls } = fakeRun({
    labels: requiredLabels(provisioned).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [{ id: 7, title: "sapwood-worker" }],
  });
  const configPath = join(dir, "sapwood.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ board: { owner: "acme", repo: "widgets", projectNumber: 7 }, worker: { deployKeyPath: keyPath, deployKeyId: 7 } }),
  );
  try {
    const { actions } = await init(provisioned, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      isInteractive: () => true,
      promptOperator: async () => "b",
      hostname: () => "host",
      sshKeygen: failSshKeygen,
      probeSshAuth: failProbeSshAuth,
    });
    assert.ok(!calls.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add"));
    assert.ok(!calls.some((c) => c.join(" ").includes("delete")));
    assert.ok(actions.some((a) => a.startsWith("deploy key: WARN")));
    const reparsed = parseConfig(readFileSync(configPath, "utf8"));
    assert.equal(reparsed.worker.deployKeyPath, undefined, "the file no longer PARSES with the anchor");
    assert.equal(reparsed.worker.deployKeyId, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (no-TTY default (b), R3-2 JSON): starting from an ACTUALLY-configured stale (path, id) anchor in a JSON config, the non-interactive default clears the anchor — the file no longer PARSES with it", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir);
  const provisioned = parseConfig(
    JSON.stringify({ board: { owner: "acme", repo: "widgets", projectNumber: 7 }, worker: { deployKeyPath: keyPath, deployKeyId: 999 } }),
  );
  const { run, calls } = fakeRun({
    labels: requiredLabels(provisioned).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    // the recorded id (999) is not registered at all -> reconcile fails on "not listed"
    deployKeyEntries: [{ id: 7, title: "sapwood-worker" }],
  });
  const configPath = join(dir, "sapwood.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ board: { owner: "acme", repo: "widgets", projectNumber: 7 }, worker: { deployKeyPath: keyPath, deployKeyId: 999 } }),
  );
  try {
    const { actions } = await init(provisioned, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: failSshKeygen,
      probeSshAuth: failProbeSshAuth,
    });
    assert.ok(!calls.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add"));
    assert.ok(!calls.some((c) => c.join(" ").includes("delete")));
    assert.ok(actions.some((a) => a.startsWith("deploy key: WARN")));
    const reparsed = parseConfig(readFileSync(configPath, "utf8"));
    assert.equal(reparsed.worker.deployKeyPath, undefined, "the file no longer PARSES with the anchor");
    assert.equal(reparsed.worker.deployKeyId, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: a SECOND run against a config that already has BOTH worker.deployKeyPath and worker.deployKeyId set RECONCILES (never skips outright) — the reconcile path itself makes at most one deploy-key list call, no add", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir); // see the RECONCILE test above for why this must be absolute
  const provisioned = parseConfig(
    `board: { owner: acme, repo: widgets, projectNumber: 7 }\nworker: { deployKeyPath: ${keyPath}, deployKeyId: 1 }`,
  );
  const { run, calls } = fakeRun({
    labels: requiredLabels(provisioned).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [{ id: 1, title: "sapwood-worker", key: FAKE_PUB_KEY }],
  });
  try {
    writeFakeKeyPair(keyPath);
    const { actions } = await init(provisioned, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: failSshKeygen,
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.ok(!calls.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add"), "reconcile never re-provisions when green");
    assert.equal(
      calls.filter((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "list").length,
      1,
      "exactly one list call to reconcile",
    );
    assert.ok(actions.some((a) => /reconciled/.test(a)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: without repo-admin (gh repo deploy-key add fails during fresh provisioning) -> L0 fallback guidance WARN naming the manual ssh-keygen command, the repo Settings -> Deploy keys step, the config keys, and a docs anchor; engine stays fully functional", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
    deployKeyAddError: "HTTP 403: Must have admin rights to Repository.",
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
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
    assert.match(warn!, /worker\.deployKeyPath.*worker\.deployKeyId|worker\.deployKeyId.*worker\.deployKeyPath/, "names both config keys");
    assert.match(warn!, /docs\/security\.md/, "carries a docs anchor");
    assert.match(warn!, /L0/, "states the engine stays functional at L0");
    assert.ok(actions.some((a) => /labels already present|created \d+ label/.test(a)));
    const configText = readFileSync(join(dir, "sapwood.config.yaml"), "utf8");
    assert.doesNotMatch(configText, /deployKeyPath:/, "no deployKeyPath written when provisioning failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (#554 pattern): fresh provisioning succeeds but the SSH auth preflight fails -> guidance WARN naming the re-provision instruction; config is NOT written", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
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

test("init (P1-6/R3-7): .gitignore already ending with the exact rooted rule as its LAST line is left byte-for-byte untouched — a true idempotent no-op", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
  });
  const dir = tmpCwd();
  try {
    const original =
      "node_modules/\n# sapwood: worker deploy key(s) — kept out of `git add -A` (see docs/security.md)\n/data/worker-deploy-key*\n";
    writeFileSync(join(dir, ".gitignore"), original);
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async (path) => {
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), original, "byte-for-byte untouched — the exact rule already sits last");
    assert.ok(!actions.some((a) => a.includes("appended") && a.includes("worker-deploy-key")), "no append action reported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (gate② round 3, item 1): a .gitignore whose last line is the rule WITH LEADING WHITESPACE is NOT treated as already covered — git treats leading spaces as part of the pattern itself, so that line does not actually ignore the key; the exact rule must still be appended", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
  });
  const dir = tmpCwd();
  try {
    // Leading spaces before the pattern — a DIFFERENT, non-matching gitignore pattern to git,
    // even though `.trim()` would make it look identical to the required rule.
    const original = "node_modules/\n  /data/worker-deploy-key*\n";
    writeFileSync(join(dir, ".gitignore"), original);
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async (path) => {
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    const lines = readFileSync(join(dir, ".gitignore"), "utf8").split("\n");
    const lastNonBlank = [...lines].reverse().find((l) => l.trim().length > 0);
    assert.equal(lastNonBlank, "/data/worker-deploy-key*", "the EXACT rule (no leading whitespace) is now the file's last effective line");
    assert.ok(
      lines.some((l) => l === "  /data/worker-deploy-key*"),
      "the pre-existing indented (non-matching) line is left in place, untouched",
    );
    assert.ok(
      actions.some((a) => a.includes("appended") && a.includes("worker-deploy-key")),
      "the append action is reported — the indented line must never be read as 'already covered'",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (R3-7): a pre-existing 'data/' rule that is NOT the file's last line does not count as coverage — the exact rule is still appended at EOF (last-match-wins; no gitignore evaluator, deliberately)", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
  });
  const dir = tmpCwd();
  try {
    // A generic `data/` rule sits in the file, but is FOLLOWED by an unrelated negation —
    // exactly the ordering hazard R3-7 exists to close: an unordered "is data/ present
    // somewhere" check would have wrongly treated this as covered.
    writeFileSync(join(dir, ".gitignore"), "data/\n!data/keep-this.txt\n");
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async (path) => {
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    const lines = readFileSync(join(dir, ".gitignore"), "utf8").split("\n");
    const lastNonBlank = [...lines].reverse().find((l) => l.trim().length > 0);
    assert.equal(lastNonBlank, "/data/worker-deploy-key*", "the exact rule was appended and is now the file's last effective line");
    assert.ok(
      lines.some((l) => l.trim() === "data/"),
      "the pre-existing data/ rule is left in place, untouched",
    );
    assert.ok(
      actions.some((a) => a.includes("appended") && a.includes("worker-deploy-key")),
      "the append action is reported even though a data/-shaped rule already existed earlier in the file",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (P2-7): L1 active + default branch UNPROTECTED (confirmed via a 404) -> WARN naming branch protection as the fix", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
    defaultBranch: "main",
    branchProtected: false,
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async (path) => {
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    const warn = actions.find((a) => a.startsWith("deploy key: WARN") && /NO branch protection/i.test(a));
    assert.ok(warn, "expected the confirmed-unprotected WARN action line");
    assert.match(warn!, /main/);
    assert.match(warn!, /branch protection/i, "names branch protection as the fix");
    assert.doesNotMatch(warn!, /cannot verify/i, "a confirmed 404 is not the same as an unverifiable state");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (P2-7): branch protection status CANNOT BE VERIFIED (403/plan-limit/anything not a parseable 404) -> a DISTINCT cannot-verify WARN, never read as confirmed-unprotected", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
    defaultBranch: "main",
    branchProtected: false,
    branchProtectionUnverifiableError: "HTTP 403: Upgrade to GitHub Pro or make this repository public to use this endpoint",
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async (path) => {
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    const warn = actions.find((a) => a.startsWith("deploy key: WARN") && /cannot verify/i.test(a));
    assert.ok(warn, "expected a distinct cannot-verify WARN action line");
    assert.match(warn!, /main/);
    assert.match(warn!, /Upgrade to GitHub Pro/i, "carries the underlying reason");
    assert.match(warn!, /treat the default branch as UNPROTECTED/i);
    assert.doesNotMatch(
      warn!,
      /^deploy key: WARN — default branch "main".*has NO branch protection rule\./,
      "never phrased as a CONFIRMED-unprotected finding",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (R3-5 i): a FAILURE TO READ the default branch itself -> the cannot-verify WARN, never a silent no-op", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
    defaultBranchReadError: "HTTP 500: Internal Server Error",
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async (path) => {
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    const warn = actions.find((a) => a.startsWith("deploy key: WARN") && /cannot verify/i.test(a));
    assert.ok(warn, "a failure to even read the default branch must still produce the cannot-verify WARN, not silence");
    assert.match(warn!, /could not read its default branch/i);
    assert.match(warn!, /Internal Server Error/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (R3-5 ii): legacy protection 404s, but a RULESET covers the branch -> treated as protected, not confirmed-unprotected", async () => {
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
    defaultBranch: "main",
    branchProtected: false, // legacy endpoint 404s
    rulesetEntries: [{ id: 1, name: "protect main" }], // but a ruleset covers the branch
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async (path) => {
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.ok(
      calls.some((c) => c[0] === "api" && (c[1] ?? "").includes("/rules/branches/")),
      "the ruleset endpoint must be queried after the legacy endpoint 404s",
    );
    assert.ok(
      !actions.some((a) => a.startsWith("deploy key: WARN") && /branch protection/i.test(a)),
      "no WARN — a ruleset counts as protected",
    );
    assert.ok(actions.some((a) => /default branch "main".*is protected.*ruleset/i.test(a)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (R3-5 ii): legacy protection 404s AND the ruleset read itself fails -> cannot-verify, never confirmed-unprotected", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
    defaultBranch: "main",
    branchProtected: false,
    rulesetReadError: "HTTP 403: Upgrade to GitHub Pro or make this repository public to use this endpoint",
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async (path) => {
        writeFileSync(path, "k");
        writeFileSync(`${path}.pub`, "p");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    const warn = actions.find((a) => a.startsWith("deploy key: WARN") && /cannot verify/i.test(a));
    assert.ok(warn, "a ruleset-read failure after a legacy 404 must produce the cannot-verify WARN, never confirmed-unprotected");
    assert.match(warn!, /ruleset status could not be read/i);
    assert.doesNotMatch(warn!, /has NO branch protection rule/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: L1 active + default branch IS protected -> a positive confirmation action, no WARN", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
    defaultBranch: "main",
    branchProtected: true,
  });
  const dir = tmpCwd();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
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

test("fakeRun (P1-1 regression pin): --jq without --json on a non-'api' gh command is REJECTED — the invalid argv can never go green again", async () => {
  const { run } = fakeRun({});
  await assert.rejects(() => run(["repo", "deploy-key", "list", "-R", "acme/widgets", "--jq", ".[].title"]), /--jq without --json/);
  // the api form (--jq alone, no --json) stays legal — different gh flag semantics.
  await assert.doesNotReject(() => run(["api", "repos/acme/widgets/milestones?state=all", "--paginate", "--jq", ".[].title"]));
});
