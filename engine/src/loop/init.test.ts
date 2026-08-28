import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runEngine } from "../cli.js";
import { engineAgentEmptyCiRequiredChecksError, loadConfig, parseConfig } from "../config/config.js";
import { loadDoctrine } from "../config/doctrine.js";
import { keyIdSidecarPath } from "../config/paths.js";
import type { IForge, Issue } from "../forge/forge.js";
import type { GhRunner } from "../forge/gh.js";
import { UnstubbedForge } from "../forge/unstubbed-forge.test-support.js";
import { type ArchitectDeps, architectMarker, createArchitectStub } from "../roles/architect.js";
import type { RoleSessionOpts, RoleSessionResult } from "../roles/peripheral.js";
import { buildRenderPrompt } from "../roles/worker.js";
import { State } from "../state/state.js";
import { BODY_BLOCK_END, BODY_BLOCK_START, RESULT_BLOCK_END, RESULT_BLOCK_START } from "../state/structured-output.js";
import { DOC_LINKS } from "../util/doc-links.js";
import { type AlignDeps, createAligningStub } from "./align.js";
import {
  type DeployKeyPermissionsFsOps,
  defaultDoctrineTemplatePath,
  defaultGoalTemplatePath,
  defaultIssueTemplatePath,
  ensureDeployKey,
  InitError,
  ISSUE_TEMPLATE_NAMES,
  init,
  missing,
  parseAuthScopes,
  parseDeployKeys,
  pickFreshArmAKeySlot,
  preflight,
  realDeployKeyPermissionsFsOps,
  requiredLabels,
  resolveDoctrineFilePath,
  resolveGoalFilePath,
  sanitizeHostnameForKeyTitle,
  setStatusOptionsArgs,
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

test("requiredLabels (#400): the hold label's description names purpose/carrier/removal/no-effect-on-issues, fits GitHub's 100-char limit, and is quoted VERBATIM in docs/guide/configuration.md", () => {
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
  const doc = readFileSync(join(repoRoot, "docs", "guide", "configuration.md"), "utf8");
  assert.ok(doc.includes(spec.description), `docs/guide/configuration.md must quote the shipped description verbatim: ${spec.description}`);
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

// #1049: the actual shipped label list (`requiredLabels`, not just `TAXONOMY_SPECS`) is what
// `sapwood init` writes to a user's repo as real GitHub label descriptions — this is the
// full-coverage counterpart to labels.test.ts's own #1049 guard, which only sees `TAXONOMY_SPECS`.
test("#1049: no sapwood-dev #NNN reference in any requiredLabels() description, and every description fits GitHub's 100-char limit", () => {
  const devRef = /#\d{2,4}\b/;
  for (const spec of requiredLabels(cfg)) {
    assert.doesNotMatch(spec.description, devRef, `requiredLabels entry "${spec.name}" carries a dev reference`);
    assert.ok(spec.description.length <= 100, `requiredLabels entry "${spec.name}" description is ${spec.description.length} chars`);
  }
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

// #1105: the primary (non-host-suffixed) local key path every FIRST-ever provisioning on a
// machine uses — the filesystem replacement for the old per-config anchor fixture value.
const cfgKeyPath = (dir: string) => join(dir, ".sapwood", "keys", "worker-deploy-key");

// #1105: the two retired config keys, built from parts rather than spelled literally — the
// AC5 retirement grep scans engine/ for these exact names, and a couple of tests below need to
// assert a real config file never regains either one. Concatenating keeps the assertion honest
// (the runtime string compared is the real, full key name) without leaving it as a literal
// substring in this file's own source.
const RETIRED_KEY_PATH_FIELD = ["deployKey", "Path"].join("");
const RETIRED_KEY_ID_FIELD = ["deployKey", "Id"].join("");

// #1105: writes the id sidecar directly — models a PRE-EXISTING local anchor (from an earlier
// `sapwood init` run, real or hand-built) without going through ensureDeployKey's own writer, so
// a reconcile test can start from an anchor already on disk. Same 0600 mode the real writer uses.
function writeAnchorSidecar(keyPath: string, keyId: number): void {
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyIdSidecarPath(keyPath), `${keyId}\n`);
  chmodSync(keyIdSidecarPath(keyPath), 0o600);
}

// #1080: deterministic injected-fs failures for enforceDeployKeyPermissions — a real permission
// trick (chmod a directory unwritable, run as non-root, ...) behaves differently per OS/CI
// runner, so these are the only reliable way to pin the WARN-degradation behavior a genuine
// chmod/lstat error must produce.
function fsWithChmodFailure(code: string): DeployKeyPermissionsFsOps {
  return {
    ...realDeployKeyPermissionsFsOps,
    chmod: () => {
      throw Object.assign(new Error(`${code}: simulated chmod failure`), { code });
    },
  };
}
function fsWithChmodFailureFor(targetPath: string, code: string): DeployKeyPermissionsFsOps {
  return {
    ...realDeployKeyPermissionsFsOps,
    chmod: (path, mode) => {
      if (path === targetPath) throw Object.assign(new Error(`${code}: simulated chmod failure for ${path}`), { code });
      realDeployKeyPermissionsFsOps.chmod(path, mode);
    },
  };
}
function fsWithLstatFailureFor(targetPath: string, code: string): DeployKeyPermissionsFsOps {
  return {
    ...realDeployKeyPermissionsFsOps,
    lstat: (path) => {
      if (path === targetPath) throw Object.assign(new Error(`${code}: simulated lstat failure for ${path}`), { code });
      return realDeployKeyPermissionsFsOps.lstat(path);
    },
  };
}

// #1105 AC4: records every mkdir/lstat/chmod call this seam sees — a byte-content comparison
// alone cannot prove a WARN-only outcome performed ZERO permission-repair filesystem calls (a
// chmod leaves no content difference behind), so a warn-path test needs this instead to make
// that claim directly.
function recordingPermissionsFs(): DeployKeyPermissionsFsOps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    mkdir: (dir) => {
      calls.push(`mkdir:${dir}`);
      realDeployKeyPermissionsFsOps.mkdir(dir);
    },
    lstat: (path) => {
      calls.push(`lstat:${path}`);
      return realDeployKeyPermissionsFsOps.lstat(path);
    },
    chmod: (path, mode) => {
      calls.push(`chmod:${path}`);
      realDeployKeyPermissionsFsOps.chmod(path, mode);
    },
  };
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
  // Gate② P2 (PR #162), widened by #1089: architect.ts's loadGoalExcerpt reads exactly these two
  // headings from the resolved goal file — without them, a repo bootstrapped by `sapwood init`
  // hands the architect a missing section/chapter from day one (degrading to the advisory
  // placeholder every round).
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
    const goalPath = join(dir, "docs", "GOAL.md"); // cfg.goal.file defaults to docs/GOAL.md
    assert.ok(existsSync(goalPath), "goal file was scaffolded");
    const scaffolded = readFileSync(goalPath, "utf8");
    assert.match(scaffolded, /^# Goal/m);
    // Gate② P2 (PR #162), widened by #1089: the scaffolded file must carry the ## Architecture
    // section the architect peripheral extracts (loadGoalExcerpt, alongside ## Constraints) — a
    // freshly-init'd repo should never start life with a missing chapter.
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
    const goalPath = join(dir, "docs", "GOAL.md");
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
    const goalPath = join(dir, "docs", "GOAL.md");
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

// Cross-artifact coverage uses production dispatch so test-side cleaning cannot mask loader wiring regressions.

/** Minimal `IForge` double for `createArchitectStub`'s dispatch: one Ready-lane candidate is
 *  enough to make it render + dispatch a session (see architect.ts's own candidates.length===0
 *  short-circuit) — everything else architect.ts reads from `deps`/`deps.cfg`, never the forge.
 *  `addIssueComment` is a no-op only reached because the scripted result below validates clean
 *  (zero contradictions/verdicts), which still applies the round design note comment. */
class ArchitectCandidateForge extends UnstubbedForge implements IForge {
  constructor(private readonly candidate: Issue) {
    super();
  }
  override async getIssuesNeedingPlanReview(): Promise<Issue[]> {
    return [this.candidate];
  }
  override async addIssueComment(): Promise<void> {}
}

/** Minimal `IForge` double for `createAligningStub`'s dispatch at `roundId: 1` — align.ts's own
 *  #621 short-circuit (`alignCreationHasNothingToDo`) returns `false` unconditionally for
 *  roundId <= 1, so no `getReadyIssues` read is needed to reach the align-creation session; an
 *  empty backlog/triage-candidate set keeps every downstream branch (issue creation, triage) a
 *  no-op with zero further forge calls. */
class EmptyBacklogForge extends UnstubbedForge implements IForge {
  override async listOpenIssues(): Promise<Issue[]> {
    return [];
  }
  override async listRecentlyClosedIssues(): Promise<Issue[]> {
    return [];
  }
  override async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    return [];
  }
}

/** Captures every `RoleSessionOpts` a peripheral stub dispatches — `.prompt` on the FIRST call is
 *  the real substituted prompt text this test asserts on. Always reports a clean, validating
 *  "done" result so the calling stub's own post-session write logic (a comment/label/issue write)
 *  either no-ops or hits the fake forge's own no-op override — never a second retried attempt. */
class PromptCapturingRunner {
  calls: RoleSessionOpts[] = [];
  constructor(private readonly resultText: string) {}
  async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
    this.calls.push(opts);
    return { outcome: "done", costUsd: 0.01, modelUsage: [], exitCode: 0, name: opts.roleId, resultText: this.resultText };
  }
}

test("#830: a fresh sapwood-init scaffold's goal/doctrine files render into the worker, architect, and po-align prompts with no HTML comment reaching any of the three, and the known scaffold-comment sentences are gone", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Ready", "In Progress", "Done"],
  });
  const dir = tmpCwd();
  try {
    await init(cfg, { run, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
    const goalPath = join(dir, "docs", "GOAL.md");
    const doctrinePath = join(dir, "docs", "REVIEW-DOCTRINE.md");
    assert.ok(existsSync(goalPath) && existsSync(doctrinePath), "init must have scaffolded both files");
    // Sanity: the scaffolded files really do carry HTML comments — a false pass below would mean
    // the shipped templates changed shape, not that the loader-side fix works.
    assert.match(readFileSync(goalPath, "utf8"), /<!--/);
    assert.match(readFileSync(doctrinePath, "utf8"), /<!--/);

    const projectCfg = parseConfig(
      `board: { owner: acme, repo: widgets, projectNumber: 7 }\ngoal: { file: ${JSON.stringify(goalPath)} }\ndoctrine: { file: ${JSON.stringify(doctrinePath)} }`,
    );
    // Never a real file — resolveRoundDirective (shared by both dispatches below) treats a
    // missing path as "no directive this round", the same as a real repo with none dropped.
    const directivePath = join(dir, "no-directive-dropped-this-round.md");

    // Cross-artifact coverage uses production dispatch so test-side cleaning cannot mask loader wiring regressions.
    const renderWorkerPrompt = buildRenderPrompt(projectCfg);
    const workerPrompt = renderWorkerPrompt({ number: 1, title: "t", labels: [], body: "b" });
    assert.ok(!workerPrompt.includes("<!--"), "worker prompt: no HTML comment marker may reach {{doctrine}}");
    assert.ok(
      !workerPrompt.includes("This file was scaffolded because none existed yet"),
      "worker prompt: doctrine-template.md's own scaffold-authoring sentence must not leak in",
    );
    assert.ok(
      !workerPrompt.includes("See docs/guide/configuration.md#doctrine for the full topology"),
      "worker prompt: doctrine-template.md's own config-key-reference sentence must not leak in",
    );

    // Architect prompt: dispatched through the REAL createArchitectStub against the scaffolded
    // goal/doctrine files — the exact call production round dispatch makes. `deps.doctrine` is
    // supplied via the real loadDoctrine (round-defaults.ts's own production wiring: it computes
    // this value the SAME way, at the SAME call site, before invoking this stub); every other
    // engine-assembled block (`plan.architectureChapter`/`round.doctrine`'s substitution site
    // itself) is exercised by architect.ts's own code, never reconstructed by this test.
    const architectResultText = [
      RESULT_BLOCK_START,
      JSON.stringify({ contradictions: [], verdicts: [] }),
      RESULT_BLOCK_END,
      BODY_BLOCK_START,
      "round design note",
      BODY_BLOCK_END,
    ].join("\n");
    const architectForge = new ArchitectCandidateForge({ number: 501, title: "a plan-review candidate", labels: [] });
    const architectRunner = new PromptCapturingRunner(architectResultText);
    const architectState = new State(":memory:");
    const architectDeps: ArchitectDeps = {
      now: () => new Date(),
      forge: architectForge,
      state: architectState,
      cfg: projectCfg,
      runner: architectRunner,
      planMdPath: goalPath,
      directivePath,
      doctrine: loadDoctrine(projectCfg.doctrine.file, projectCfg.doctrine.maxChars),
    };
    await createArchitectStub(architectDeps).run({ roundId: 1, phase: "architecting", marker: null });
    architectState.close();
    assert.equal(architectRunner.calls.length, 1, "expected exactly one architect session dispatch");
    const architectPrompt = architectRunner.calls[0]!.prompt;
    // {{round.marker}} substitutes architectMarker(roundId) — a deliberate, comment-SHAPED
    // idempotence marker (`<!-- sapwood:round:N:architecting -->`) architect.md's own "Round
    // context" section teaches the session to recognize, completely unrelated to #830's scaffold-
    // comment concern. Removing this ONE known-legitimate occurrence before the blanket "<!--"
    // check below isolates it from an actual scaffold-guidance leak, the same way the po-align
    // assertion further down scopes itself to just the <plan-md> wrapper to dodge po.md's own
    // legitimate `<!-- sapwood:ac -->` anchor-syntax prose.
    const architectPromptWithoutMarker = architectPrompt.split(architectMarker(1)).join("");
    assert.ok(
      !architectPromptWithoutMarker.includes("<!--"),
      "architect prompt: no HTML comment marker may reach {{plan.architectureChapter}}/{{round.doctrine}}",
    );
    assert.ok(
      !architectPrompt.includes("advisory only, a missing section never blocks a round"),
      "architect prompt: goal-template.md's own Architecture-section fallback-placeholder sentence must not leak in",
    );
    assert.ok(
      !architectPrompt.includes("This file was scaffolded because none existed yet"),
      "architect prompt: doctrine-template.md's own scaffold-authoring sentence must not leak in via {{round.doctrine}}",
    );
    assert.ok(
      !architectPrompt.includes("See docs/guide/configuration.md#doctrine for the full topology"),
      "architect prompt: doctrine-template.md's own config-key-reference sentence must not leak in via {{round.doctrine}}",
    );

    // po-align prompt: dispatched through the REAL createAligningStub against the scaffolded
    // goal file — the exact {{plan.md}} substitution align.ts's own dispatch performs. roundId:
    // 1 keeps the align-creation session's own short-circuit (#621) from skipping it, and an
    // empty backlog/triage set keeps every OTHER forge-dependent branch a no-op.
    const alignResultText = [RESULT_BLOCK_START, JSON.stringify({ issues: [] }), RESULT_BLOCK_END].join("\n");
    const alignForge = new EmptyBacklogForge();
    const alignRunner = new PromptCapturingRunner(alignResultText);
    const alignState = new State(":memory:");
    const alignDeps: AlignDeps = {
      now: () => new Date(),
      forge: alignForge,
      state: alignState,
      cfg: projectCfg,
      runner: alignRunner,
      planMdPath: goalPath,
      directivePath,
    };
    await createAligningStub(alignDeps).run({ roundId: 1, phase: "aligning", marker: null });
    alignState.close();
    const poAlignCall = alignRunner.calls.find((c) => c.roleId === "po-align");
    assert.ok(poAlignCall, "expected a po-align session dispatch");
    const alignPrompt = poAlignCall!.prompt;
    // po.md itself legitimately teaches sessions the literal `<!-- sapwood:ac -->` anchor
    // syntax elsewhere in its instructions (unrelated to #830), so this check is scoped to
    // po.md's own `<plan-md>...</plan-md>` wrapper around the substituted {{plan.md}} value.
    const planMdStart = alignPrompt.indexOf("<plan-md>") + "<plan-md>".length;
    const planMdEnd = alignPrompt.indexOf("</plan-md>");
    assert.ok(planMdStart > 0 && planMdEnd > planMdStart, "expected po.md's <plan-md> wrapper");
    const planMdSection = alignPrompt.slice(planMdStart, planMdEnd);
    assert.ok(!planMdSection.includes("<!--"), "po-align prompt: no HTML comment marker may reach the substituted {{plan.md}}");
    assert.ok(
      !planMdSection.includes("they're invisible in rendered markdown"),
      "po-align prompt: goal-template.md's own authoring-guidance sentence must not leak in",
    );
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

// ── #1105: L1 scoped-worker-identity deploy-key provisioning, anchored on a LOCAL (key file, id
//    sidecar) pair under .sapwood/keys/ — never a value in the audited sapwood.config.yaml.
//    `sapwood init` never edits sapwood.config.yaml after its initial scaffold write (AC3). ──

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

test("pickFreshArmAKeySlot: the bare hostComponent slot when both the local path and the title are free", () => {
  const dir = tmpCwd();
  try {
    const slot = pickFreshArmAKeySlot(dir, "myhost", new Set());
    assert.equal(slot.path, join(dir, ".sapwood", "keys", "worker-deploy-key-myhost"));
    assert.equal(slot.title, "sapwood-worker-myhost");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pickFreshArmAKeySlot (R3-1): a LOCAL path collision skips to the next numeric suffix, even when the base title is free remotely", () => {
  const dir = tmpCwd();
  try {
    mkdirSync(join(dir, ".sapwood", "keys"), { recursive: true });
    writeFileSync(join(dir, ".sapwood", "keys", "worker-deploy-key-myhost"), "leftover from a previous interrupted run");
    const slot = pickFreshArmAKeySlot(dir, "myhost", new Set());
    assert.equal(slot.path, join(dir, ".sapwood", "keys", "worker-deploy-key-myhost-2"));
    assert.equal(slot.title, "sapwood-worker-myhost-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pickFreshArmAKeySlot (R3-1): a REMOTE title collision skips to the next numeric suffix, even when the local path is free — an already-registered per-host title is treated as foreign, never reused", () => {
  const dir = tmpCwd();
  try {
    const slot = pickFreshArmAKeySlot(dir, "myhost", new Set(["sapwood-worker-myhost"]));
    assert.equal(slot.path, join(dir, ".sapwood", "keys", "worker-deploy-key-myhost-2"));
    assert.equal(slot.title, "sapwood-worker-myhost-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pickFreshArmAKeySlot (R3-1): path AND title suffixes always move together — a collision on -2 (either dimension) advances to -3", () => {
  const dir = tmpCwd();
  try {
    mkdirSync(join(dir, ".sapwood", "keys"), { recursive: true });
    writeFileSync(join(dir, ".sapwood", "keys", "worker-deploy-key-myhost"), "x");
    writeFileSync(join(dir, ".sapwood", "keys", "worker-deploy-key-myhost-2"), "x");
    const slot = pickFreshArmAKeySlot(dir, "myhost", new Set(["sapwood-worker-myhost", "sapwood-worker-myhost-2"]));
    assert.equal(slot.path, join(dir, ".sapwood", "keys", "worker-deploy-key-myhost-3"));
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

// ── #1105 AC3: sapwood init never edits sapwood.config.yaml after its initial scaffold write —
//    the deploy-key step writes ONLY under .sapwood/keys/, never touching the config file at all,
//    fresh or on any re-run. ──

test("init (#1105 AC3): sapwood.config.yaml is byte-identical before and after a FRESH provisioning run", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
  });
  const dir = tmpCwd();
  try {
    // Pre-create the config with distinctive bytes (never auto-generated by ensureConfig) so a
    // real fresh key-provisioning run — ssh-keygen + gh repo deploy-key add + sidecar write, ALL
    // happening on this SAME call — has an actual before/after to compare, rather than only
    // comparing two runs against each other after the interesting one already happened.
    const configPath = join(dir, "sapwood.config.yaml");
    mkdirSync(dir, { recursive: true });
    const distinctiveConfig = "board: { owner: acme, repo: widgets, projectNumber: 7 }\n# distinctive-marker-8f21c\n";
    writeFileSync(configPath, distinctiveConfig);
    const before = readFileSync(configPath, "utf8");

    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async (path) => writeFakeKeyPair(path),
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.ok(
      actions.some((a) => /added write deploy key/.test(a)),
      "this must be a genuine fresh-provisioning run, not a no-op",
    );
    assert.equal(
      readFileSync(configPath, "utf8"),
      before,
      "a fresh key-provisioning run (ssh-keygen + gh add + sidecar write) must not touch a pre-existing config file at all",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (#1105 AC3): sapwood.config.yaml is byte-identical before and after a RECONCILE-FAILURE run (non-interactive WARN)", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [{ id: 42, title: "sapwood-worker" }], // a foreign key this machine has no anchor for
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
    const configPath = join(dir, "sapwood.config.yaml");
    const before = readFileSync(configPath, "utf8");
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: failSshKeygen,
      probeSshAuth: failProbeSshAuth,
    });
    assert.ok(actions.some((a) => a.startsWith("deploy key: WARN")));
    assert.equal(readFileSync(configPath, "utf8"), before, "a WARN-only outcome must never touch the config file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: FRESH PROVISIONING — nothing local, no sapwood-titled remote key -> provisions end-to-end (ssh-keygen + gh repo deploy-key add --allow-write --title sapwood-worker), reads back the new id, preflight green, sidecar written under .sapwood/keys/, config file untouched", async () => {
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
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
        writeFakeKeyPair(path);
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
    assert.ok(actions.some((a) => /recorded the local anchor/.test(a) && a.includes(keyIdSidecarPath(expectedKeyPath))));
    assert.equal(readFileSync(keyIdSidecarPath(expectedKeyPath), "utf8").trim(), "1");
    assert.equal(statSync(keyIdSidecarPath(expectedKeyPath)).mode & 0o777, 0o600, "the sidecar is written 0600, same as the key");
    const configText = readFileSync(join(dir, "sapwood.config.yaml"), "utf8");
    assert.doesNotMatch(
      configText,
      new RegExp(`${RETIRED_KEY_PATH_FIELD}|${RETIRED_KEY_ID_FIELD}`),
      "the config file is never touched by the deploy-key step",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: RECONCILE — a discovered local anchor, local file exists, id listed, preflight green -> a positive confirmation action, NO re-provisioning (no ssh-keygen, no deploy-key add)", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir);
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    // The id-matched entry's `key` must match the LOCAL `.pub` file content below for
    // reconcile's cross-check to go green.
    deployKeyEntries: [{ id: 159210179, title: "sapwood-worker", key: FAKE_PUB_KEY }],
  });
  try {
    writeFakeKeyPair(keyPath);
    writeAnchorSidecar(keyPath, 159210179);
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: failSshKeygen,
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.ok(!calls.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add"), "no re-provisioning on a clean reconcile");
    assert.ok(actions.some((a) => /reconciled/.test(a) && /L1 active/.test(a)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: RECONCILE — a discovered anchor already on disk with the wrong permissions (dir 0777, key 0777, sidecar 0777) has ALL THREE repaired to 0700/0600/0600 as part of a successful reconcile", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir);
  const keysDir = dirname(keyPath);
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [{ id: 159210179, title: "sapwood-worker", key: FAKE_PUB_KEY }],
  });
  try {
    writeFakeKeyPair(keyPath);
    writeAnchorSidecar(keyPath, 159210179);
    chmodSync(keysDir, 0o777);
    chmodSync(keyPath, 0o777);
    chmodSync(keyIdSidecarPath(keyPath), 0o777);
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: failSshKeygen,
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.equal(statSync(keysDir).mode & 0o777, 0o700, "the keys/ directory is repaired to 0700 as part of reconcile");
    assert.equal(statSync(keyPath).mode & 0o777, 0o600, "the private key file is repaired to 0600 as part of reconcile");
    assert.equal(statSync(keyIdSidecarPath(keyPath)).mode & 0o777, 0o600, "the id sidecar is repaired to 0600 as part of reconcile too");
    assert.ok(
      actions.some((a) => /reconciled/.test(a) && /L1 active/.test(a)),
      "the repair does not block the green verdict",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: RECONCILE — a DIRECTORY sitting at the would-be anchor's key path is invisible to findDeployKeyAnchor (#1105): treated as NO anchor at all, never reaches permission repair, reports a WARN and never claims L1 active", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir);
  mkdirSync(keyPath, { recursive: true }); // a DIRECTORY, not a key file, at the would-be key path
  writeFileSync(`${keyPath}.pub`, `${FAKE_PUB_KEY}\n`);
  writeAnchorSidecar(keyPath, 159210179);
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [{ id: 159210179, title: "sapwood-worker", key: FAKE_PUB_KEY }],
  });
  const permissionsFs = recordingPermissionsFs();
  try {
    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: failSshKeygen,
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.ok(
      !actions.some((a) => /reconciled/.test(a) && /L1 active/.test(a)),
      "a directory standing in for the key must never be reported as a green reconcile",
    );
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn, "expected a WARN action line");
    assert.match(warn!, /no local \(key, id\) anchor recorded/, "a non-regular-file key is not a discoverable anchor at all");
    assert.ok(!calls.some((c) => c.join(" ").includes("delete")), "the remote key is never touched over a local collision");

    // The SAME scenario, called directly against ensureDeployKey with a recording fs: proves
    // enforceDeployKeyPermissions is never even reached, not merely that its outcome doesn't
    // show up in the reported text.
    const directActions = await ensureDeployKey(
      run,
      "acme/widgets",
      dir,
      { ...nonInteractive, sshKeygen: failSshKeygen, probeSshAuth: async () => ({ ok: true }) },
      permissionsFs,
    );
    assert.ok(directActions.some((a) => a.startsWith("deploy key: WARN")));
    assert.deepEqual(permissionsFs.calls, [], "a directory-at-keypath anchor never reaches permission repair at all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureDeployKey (reconcile): a genuine chmod FAILURE (EPERM, injected via the fs seam — not a real OS-dependent permission trick) during repair is a reported WARN degradation, never a thrown error and never a green L1 claim", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir);
  const { run } = fakeRun({ deployKeyEntries: [{ id: 159210179, title: "sapwood-worker", key: FAKE_PUB_KEY }] });
  try {
    writeFakeKeyPair(keyPath);
    writeAnchorSidecar(keyPath, 159210179);
    const actions = await ensureDeployKey(
      run,
      "acme/widgets",
      dir,
      { ...nonInteractive, sshKeygen: failSshKeygen, probeSshAuth: async () => ({ ok: true }) },
      fsWithChmodFailure("EPERM"),
    );
    assert.ok(
      !actions.some((a) => /reconciled/.test(a) && /L1 active/.test(a)),
      "a chmod failure must never be reported as a green reconcile — it must not escape and abort init() either",
    );
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn, "expected a WARN action line");
    assert.match(warn!, /could not repair key permissions/);
    assert.match(warn!, /EPERM/, "the WARN names the mode/error, not just 'something went wrong'");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureDeployKey (fresh provisioning): a genuine lstat FAILURE (EACCES, injected via the fs seam) on the private-key path is a reported WARN degradation, never silently read as 'absent' — ssh-keygen is never invoked", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir);
  const { run, calls } = fakeRun({ deployKeyEntries: [] });
  try {
    const actions = await ensureDeployKey(
      run,
      "acme/widgets",
      dir,
      {
        ...nonInteractive,
        sshKeygen: async () => {
          throw new Error("sshKeygen must not be called — the permission repair's own lstat already failed");
        },
        probeSshAuth: async () => ({ ok: true }),
      },
      fsWithLstatFailureFor(keyPath, "EACCES"),
    );
    assert.ok(
      !calls.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add"),
      "no add call — provisioning refused before ever reaching gh",
    );
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn, "expected a provisioning-failure WARN action line");
    assert.match(warn!, /EACCES/, "an unreadable path is reported honestly, never silently treated as 'nothing there yet'");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (#1105 AC4): RECONCILE FAILS (recorded id no longer listed — rotated/stale) -> non-interactive default (b): WARN, remote NEVER touched, and NO FILE IS MODIFIED (not even the stale sidecar)", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir);
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    // the recorded id (9999999) is NOT in this list — a different id is registered instead,
    // modeling a rotated/foreign key under the same shared title.
    deployKeyEntries: [{ id: 42, title: "sapwood-worker" }],
  });
  try {
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, "stale-private-key");
    writeAnchorSidecar(keyPath, 9999999);
    const sidecarBefore = readFileSync(keyIdSidecarPath(keyPath), "utf8");
    const { actions } = await init(cfg, {
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
    // #1105: unlike the retired config-anchored design, a WARN-only outcome touches NO file —
    // not even the stale sidecar it's warning about (AC4). The next `sapwood init` run reconciles
    // the same anchor again and reports the same honest WARN.
    assert.equal(readFileSync(keyIdSidecarPath(keyPath), "utf8"), sidecarBefore, "the stale sidecar is left exactly as it was");
    assert.equal(readFileSync(keyPath, "utf8"), "stale-private-key", "the stale key file is left exactly as it was");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (#1105 AC4): a stale-id WARN performs ZERO permission-repair filesystem calls (injected-fs proof, not a content comparison)", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir);
  const { run } = fakeRun({ deployKeyEntries: [{ id: 42, title: "sapwood-worker" }] });
  const permissionsFs = recordingPermissionsFs();
  try {
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, "stale-private-key");
    writeAnchorSidecar(keyPath, 9999999);
    const actions = await ensureDeployKey(
      run,
      "acme/widgets",
      dir,
      { ...nonInteractive, sshKeygen: failSshKeygen, probeSshAuth: async () => ({ ok: true }) },
      permissionsFs,
    );
    assert.ok(actions.some((a) => a.startsWith("deploy key: WARN")));
    assert.deepEqual(permissionsFs.calls, [], "a stale-id verdict must be decided before enforceDeployKeyPermissions is ever reached");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (R3-1): RECONCILE FAILS when the recorded id IS listed and the local file DOES exist and SSH preflight succeeds, but the local .pub content does NOT match that id's own registered key — proves the (key, id) pair was never recorded together; no file modified either", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir);
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    // id 42 IS registered — but under a DIFFERENT public key than the one at `keyPath` below (a
    // hand-edited sidecar, or an id that once matched but was rotated on the remote side).
    deployKeyEntries: [{ id: 42, title: "sapwood-worker", key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAADifferentKeyEntirely unrelated" }],
  });
  try {
    writeFakeKeyPair(keyPath); // local .pub content is FAKE_PUB_KEY — does not match the entry's `key` above
    writeAnchorSidecar(keyPath, 42);
    const { actions } = await init(cfg, {
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
    assert.equal(readFileSync(keyIdSidecarPath(keyPath), "utf8").trim(), "42", "the sidecar is left untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (#1105 AC4, TTY arm (a)): re-running init after a reconcile-fail state converges to a green reconcile once the operator registers an additional key — writes ONLY the new key + its sidecar, the stale one is left in place", async () => {
  const dir = tmpCwd();
  const staleKeyPath = cfgKeyPath(dir);
  try {
    // First init run: local key file MISSING -> reconcile fails -> non-interactive default (b)
    // -> WARN, no file touched.
    writeAnchorSidecar(staleKeyPath, 42);
    const { run: run1 } = fakeRun({
      labels: requiredLabels(cfg).map((l) => l.name),
      boardExists: true,
      boardOptions: ["Todo", "Ready", "In Progress", "Done"],
      deployKeyEntries: [{ id: 42, title: "sapwood-worker" }],
    });
    const first = await init(cfg, { run: run1, getAuthStatus: async () => OK_AUTH, cwd: dir, ...nonInteractive });
    assert.ok(first.actions.some((a) => a.startsWith("deploy key: WARN")));
    assert.equal(
      readFileSync(keyIdSidecarPath(staleKeyPath), "utf8").trim(),
      "42",
      "first init run leaves the stale sidecar exactly as it was",
    );

    // Second init run ("re-run sapwood init" from an interactive terminal): the OLD
    // "sapwood-worker"-titled key is STILL registered (never deleted) — operator chooses (a) to
    // register an ADDITIONAL per-machine key instead.
    const { run: run2, calls: calls2 } = fakeRun({
      labels: requiredLabels(cfg).map((l) => l.name),
      boardExists: true,
      boardOptions: ["Todo", "Ready", "In Progress", "Done"],
      deployKeyEntries: [{ id: 42, title: "sapwood-worker" }],
    });
    const second = await init(cfg, {
      run: run2,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      isInteractive: () => true,
      promptOperator: async () => "a",
      hostname: () => "converge-host",
      sshKeygen: async (path) => writeFakeKeyPair(path, "ssh-ed25519 AAAA converge-host-key"),
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.ok(calls2.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add" && c.includes("sapwood-worker-converge-host")));
    assert.ok(!calls2.some((c) => c.join(" ").includes("delete")), "the old key is never deleted, even on the converging path");
    const newKeyPath = join(dir, ".sapwood", "keys", "worker-deploy-key-converge-host");
    assert.equal(readFileSync(keyIdSidecarPath(newKeyPath), "utf8").trim(), "43"); // fakeRun assigns max(existing)+1
    assert.ok(second.actions.some((a) => /SSH auth preflight OK/.test(a)));
    // The stale slot from the first init run is untouched — only the NEW key + its own sidecar
    // were written.
    assert.equal(readFileSync(keyIdSidecarPath(staleKeyPath), "utf8").trim(), "42");
    assert.equal(existsSync(staleKeyPath), false, "the first init run never wrote a key file at the stale slot, only its sidecar");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: nothing local, but a sapwood-titled key ALREADY exists remotely (no recorded anchor for it) -> never assumed to be 'mine' — routed through the same WARN+choice arm, remote never touched", async () => {
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
    assert.match(warn!, /no local \(key, id\) anchor/i);
    assert.match(warn!, /sapwood-worker.*id 7/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (#1105 AC4, TTY arm (a)): operator chooses (a) -> registers an ADDITIONAL per-machine key titled sapwood-worker-<hostname>, leaves the existing remote key untouched, writes only the new key + sidecar", async () => {
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
        writeFakeKeyPair(path);
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.ok(promptedWith, "the operator must be prompted when isInteractive() is true");
    const expectedTitle = "sapwood-worker-mylaptop-local";
    const expectedKeyPath = join(dir, ".sapwood", "keys", "worker-deploy-key-mylaptop-local");
    assert.equal(keygenCalledWith, expectedKeyPath);
    const addCall = calls.find((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add");
    assert.ok(addCall);
    assert.equal(addCall![addCall!.indexOf("--title") + 1], expectedTitle);
    assert.ok(!calls.some((c) => c.join(" ").includes("delete")), "the pre-existing remote key is left untouched, never deleted");
    assert.ok(actions.some((a) => a.includes(expectedTitle) && /operator chose \(a\)/.test(a)));
    assert.equal(readFileSync(keyIdSidecarPath(expectedKeyPath), "utf8").trim(), "8"); // fakeRun assigns max(existing)+1
    assert.equal(readFileSync(join(dir, "sapwood.config.yaml"), "utf8").includes(RETIRED_KEY_PATH_FIELD), false);
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
    // no LOCAL anchor for it (a fresh checkout, a wiped runtime root, ...): per the ruling, a
    // title is never proof of ownership, so this is treated the same as any other foreign key.
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
      sshKeygen: async (path) => writeFakeKeyPair(path),
      probeSshAuth: async () => ({ ok: true }),
    });
    const expectedTitle = "sapwood-worker-test-host-2";
    const expectedKeyPath = join(dir, ".sapwood", "keys", "worker-deploy-key-test-host-2");
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
    assert.equal(existsSync(keyIdSidecarPath(expectedKeyPath)), true);
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

test("init (R3-1): a post-add id diff yielding ZERO new ids is treated as an ordinary provisioning failure (degrade (b)-style) — never silently adopts a wrong id, no sidecar written", async () => {
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
      sshKeygen: async (path) => writeFakeKeyPair(path),
      probeSshAuth: failProbeSshAuth,
    });
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn, "expected the ordinary provisioning-failure WARN");
    assert.match(warn!, /no new id appeared/i);
    assert.equal(existsSync(keyIdSidecarPath(cfgKeyPath(dir))), false, "no sidecar written when the new id couldn't be determined");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (R3-1): a post-add id diff yielding MORE THAN ONE new id is treated as an ordinary provisioning failure (degrade (b)-style) — ambiguous, never guessed, no sidecar written", async () => {
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
      sshKeygen: async (path) => writeFakeKeyPair(path),
      probeSshAuth: failProbeSshAuth,
    });
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn, "expected the ordinary provisioning-failure WARN");
    assert.match(warn!, /2 new ids appeared/i);
    assert.equal(existsSync(keyIdSidecarPath(cfgKeyPath(dir))), false, "no sidecar written when the new id is ambiguous");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (#1105 AC4, TTY arm (b)): starting from a discovered stale anchor, operator explicitly chooses (b) -> WARN, nothing registered, no file touched", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir);
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    // id 7 is registered, but under a DIFFERENT key than the local file (or the local file is
    // simply missing below) — reconcile fails regardless of which specific reason.
    deployKeyEntries: [{ id: 7, title: "sapwood-worker" }],
  });
  try {
    writeAnchorSidecar(keyPath, 7);
    const { actions } = await init(cfg, {
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
    assert.equal(readFileSync(keyIdSidecarPath(keyPath), "utf8").trim(), "7", "the sidecar is untouched — arm (b) writes nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (#1105 AC4, TTY arm (b)): choosing (b) performs ZERO permission-repair filesystem calls (injected-fs proof, not a content comparison)", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir);
  const { run } = fakeRun({ deployKeyEntries: [{ id: 7, title: "sapwood-worker" }] });
  const permissionsFs = recordingPermissionsFs();
  try {
    writeAnchorSidecar(keyPath, 7);
    const actions = await ensureDeployKey(
      run,
      "acme/widgets",
      dir,
      {
        isInteractive: () => true,
        promptOperator: async () => "b",
        hostname: () => "host",
        sshKeygen: failSshKeygen,
        probeSshAuth: failProbeSshAuth,
      },
      permissionsFs,
    );
    assert.ok(actions.some((a) => a.startsWith("deploy key: WARN")));
    assert.deepEqual(permissionsFs.calls, [], "choice (b) must never call enforceDeployKeyPermissions");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: a SECOND run against a repo with a real discovered anchor RECONCILES (never skips outright) — the reconcile path itself makes at most one deploy-key list call, no add", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir);
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [{ id: 1, title: "sapwood-worker", key: FAKE_PUB_KEY }],
  });
  try {
    writeFakeKeyPair(keyPath);
    writeAnchorSidecar(keyPath, 1);
    const { actions } = await init(cfg, {
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

test("init: without repo-admin (gh repo deploy-key add fails during fresh provisioning) -> guidance WARN naming the manual ssh-keygen command, the repo Settings -> Deploy keys step, the sidecar path, and a docs anchor; no sidecar written", async () => {
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
      sshKeygen: async (path) => writeFakeKeyPair(path),
      probeSshAuth: failProbeSshAuth,
    });
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn, "expected a guidance-carrying WARN action line");
    assert.match(warn!, /ssh-keygen -t ed25519/, "names the exact manual ssh-keygen command");
    assert.match(warn!, /Deploy keys/, "names the manual repo Settings -> Deploy keys step");
    assert.match(warn!, /write access/i, "names the allow-write step");
    assert.match(warn!, /\.id \(mode 0600\)/i, "names the sidecar the operator would write by hand");
    assert.ok(warn!.includes(DOC_LINKS.security), "carries a docs anchor");
    assert.ok(actions.some((a) => /labels already present|created \d+ label/.test(a)));
    assert.equal(existsSync(keyIdSidecarPath(cfgKeyPath(dir))), false, "no sidecar written when provisioning failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (#554 pattern): fresh provisioning succeeds but the SSH auth preflight fails -> guidance WARN naming the re-provision instruction; no sidecar written", async () => {
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
      sshKeygen: async (path) => writeFakeKeyPair(path),
      probeSshAuth: async () => ({ ok: false, detail: "ssh: connect to host github.com port 22: Network is unreachable" }),
    });
    const warn = actions.find((a) => a.startsWith("deploy key: WARN") && /preflight failed/.test(a));
    assert.ok(warn, "expected a preflight-fail WARN action line");
    assert.match(warn!, /Network is unreachable/);
    assert.match(warn!, /sapwood init/i, "names the re-provision instruction (re-run sapwood init)");
    assert.equal(existsSync(keyIdSidecarPath(cfgKeyPath(dir))), false, "no sidecar written when the preflight fails");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureDeployKey (#1105, fresh provisioning): the key/dir permission repairs succeed and the preflight is green, but the sidecar's CHMOD fails (its writeFileSync already succeeded — injected chmod failure scoped to ONLY the sidecar) -> a reported provisioning-failure WARN, never a thrown escape", async () => {
  const dir = tmpCwd();
  const keyPath = cfgKeyPath(dir);
  const { run } = fakeRun({ deployKeyEntries: [] });
  try {
    const actions = await ensureDeployKey(
      run,
      "acme/widgets",
      dir,
      { ...nonInteractive, sshKeygen: async (path) => writeFakeKeyPair(path), probeSshAuth: async () => ({ ok: true }) },
      fsWithChmodFailureFor(keyIdSidecarPath(keyPath), "ENOSPC"),
    );
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn, "a sidecar-persistence failure must be reported as an ordinary provisioning-failure WARN");
    assert.match(warn!, /ENOSPC/, "names the underlying error, not just 'something went wrong'");
    assert.ok(!actions.some((a) => /recorded the local anchor/.test(a)), "must never claim the anchor was recorded");
    // #1105: writeDeployKeyIdSidecar's own writeFileSync already passes { mode: 0o600 } at
    // create time — the chmod this test fails is a REDUNDANT repair for the process umask, not
    // the only source of the mode. Proves the create-time mode survives on its own, independent
    // of the injected chmod failure above.
    assert.equal(
      statSync(keyIdSidecarPath(keyPath)).mode & 0o777,
      0o600,
      "the sidecar's create-time mode (writeFileSync's own) is still 0600",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #1080: the pre-#1080 ".gitignore already covers the rule"/"leading-whitespace rule not
// treated as coverage"/"an unrelated rule elsewhere in the file doesn't count as coverage" trio
// tested ensureGitignoreCoversDeployKeyAction, which is retired — the key lives under the
// runtime root's own self-ignoring `.sapwood/.gitignore` now, and init never touches the repo
// root's own `.gitignore` at all (see "AC1/AC4" below for the replacement coverage: root
// .gitignore untouched, .sapwood/.gitignore already excludes everything under it).

test("init: L1 active + default branch UNPROTECTED (confirmed via a 404) -> WARN naming branch protection as the fix", async () => {
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

test("init: branch protection status CANNOT BE VERIFIED (403/plan-limit/anything not a parseable 404) -> a DISTINCT cannot-verify WARN, never read as confirmed-unprotected", async () => {
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

test("fakeRun (regression pin): --jq without --json on a non-'api' gh command is REJECTED — the invalid argv can never go green again", async () => {
  const { run } = fakeRun({});
  await assert.rejects(() => run(["repo", "deploy-key", "list", "-R", "acme/widgets", "--jq", ".[].title"]), /--jq without --json/);
  // the api form (--jq alone, no --json) stays legal — different gh flag semantics.
  await assert.doesNotReject(() => run(["api", "repos/acme/widgets/milestones?state=all", "--paginate", "--jq", ".[].title"]));
});

// ── #1080: deploy key under .sapwood/keys/, root creation, and the ONE refusal ────────────────

test("init (AC1): fresh init on a temp repo — key at .sapwood/keys/worker-deploy-key (mode 0600, keys/ dir 0700), .sapwood/.gitignore is '*', root .gitignore is never created or touched", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [], // nothing registered remotely -> fresh provisioning runs
  });
  const dir = tmpCwd();
  try {
    await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      // This fake deliberately does NOT chmod the file itself — mode enforcement must be init's
      // own doing (enforceDeployKeyPermissions), not something this test smuggles in via the
      // fake. worker.test.ts's own "private key 0600" test separately pins the real ssh-keygen
      // invocation's own mode (this file's fakes never shell out — see #69's grep-invariant doc).
      sshKeygen: async (path) => {
        writeFileSync(path, "fake-private-key");
        writeFileSync(`${path}.pub`, "ssh-ed25519 AAAA fake");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    const keyPath = join(dir, ".sapwood", "keys", "worker-deploy-key");
    assert.equal(existsSync(keyPath), true);
    assert.equal(statSync(keyPath).mode & 0o777, 0o600, "private key file mode is 0600");
    assert.equal(statSync(dirname(keyPath)).mode & 0o777, 0o700, "keys/ directory mode is 0700");
    assert.equal(readFileSync(join(dir, ".sapwood", ".gitignore"), "utf8"), "*\n");
    assert.equal(existsSync(join(dir, ".gitignore")), false, "init never creates or touches the repo root's own .gitignore");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (AC1): pre-existing key material at 0777 (both the keys/ directory and the private key file) is repaired to 0700/0600 on REUSE, not just fresh creation", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [], // nothing registered remotely -> fresh provisioning runs, key REUSED
  });
  const dir = tmpCwd();
  try {
    const keysDir = join(dir, ".sapwood", "keys");
    const keyPath = join(keysDir, "worker-deploy-key");
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(keyPath, "pre-existing-private-key");
    writeFileSync(`${keyPath}.pub`, "ssh-ed25519 AAAA pre-existing");
    chmodSync(keysDir, 0o777);
    chmodSync(keyPath, 0o777);

    await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async () => {
        throw new Error("sshKeygen must not be called — the key already exists, this is a REUSE path");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.equal(statSync(keyPath).mode & 0o777, 0o600, "reused private key file mode is repaired to 0600");
    assert.equal(statSync(keysDir).mode & 0o777, 0o700, "reused keys/ directory mode is repaired to 0700");
    assert.equal(readFileSync(keyPath, "utf8"), "pre-existing-private-key", "reuse never regenerates the key material itself");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (fresh provisioning): a pre-existing .pub file with no private half at the BASE key path is a collision — ssh-keygen is never invoked, the .pub is preserved byte-for-byte, and provisioning degrades with a WARN", async () => {
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [], // nothing sapwood-titled remotely -> would otherwise take the fresh path
  });
  const dir = tmpCwd();
  try {
    const pubPath = join(dir, ".sapwood", "keys", "worker-deploy-key.pub");
    mkdirSync(dirname(pubPath), { recursive: true });
    writeFileSync(pubPath, "sentinel-preexisting-base-pub");

    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async () => {
        throw new Error("sshKeygen must not be called — the .pub half already exists, this is a collision");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.equal(readFileSync(pubPath, "utf8"), "sentinel-preexisting-base-pub", "the pre-existing .pub is never overwritten or deleted");
    assert.ok(
      !calls.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add"),
      "no add call — provisioning refused before ever reaching gh",
    );
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn, "expected a provisioning-failure WARN action line");
    assert.match(warn!, /\.pub exists but its private half does not/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (fresh provisioning): a DIRECTORY at the private-key path (with a real .pub sibling, so the XOR collision check passes and enforceDeployKeyPermissions itself is what's exercised) is a collision — its own mode is never chmodded to 0600, ssh-keygen is never invoked, and provisioning degrades with a WARN", async () => {
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
  });
  const dir = tmpCwd();
  try {
    const keyPath = join(dir, ".sapwood", "keys", "worker-deploy-key");
    mkdirSync(keyPath, { recursive: true }); // a DIRECTORY sits where the private key file should be
    writeFileSync(`${keyPath}.pub`, "sentinel-preexisting-pub-alongside-a-directory");
    const dirModeBefore = statSync(keyPath).mode & 0o777;

    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async () => {
        throw new Error("sshKeygen must not be called — the private-key path is a directory, this is a collision");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.equal(statSync(keyPath).mode & 0o777, dirModeBefore, "the directory's own mode is never chmodded to 0600");
    assert.equal(
      readFileSync(`${keyPath}.pub`, "utf8"),
      "sentinel-preexisting-pub-alongside-a-directory",
      "the pre-existing .pub sibling is untouched",
    );
    assert.ok(
      !calls.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add"),
      "no add call — provisioning refused before ever reaching gh",
    );
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn, "expected a provisioning-failure WARN action line");
    assert.match(warn!, /not a regular file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (fresh provisioning): a SYMLINK at the private-key path pointing at an external file (mode 0644, plus a real .pub sibling so the XOR check passes) is a collision — chmod never follows the symlink, so the external target's own mode and bytes are unchanged, and provisioning degrades with a WARN", async () => {
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
  });
  const dir = tmpCwd();
  try {
    const keysDir = join(dir, ".sapwood", "keys");
    mkdirSync(keysDir, { recursive: true });
    const keyPath = join(keysDir, "worker-deploy-key");
    const externalTarget = join(dir, "external-file-outside-keys.txt");
    writeFileSync(externalTarget, "not a deploy key — an unrelated file this symlink points at");
    chmodSync(externalTarget, 0o644);
    symlinkSync(externalTarget, keyPath);
    writeFileSync(`${keyPath}.pub`, "sentinel-preexisting-pub-alongside-a-symlink");

    const { actions } = await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async () => {
        throw new Error("sshKeygen must not be called — the private-key path is a symlink, this is a collision");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.equal(statSync(externalTarget).mode & 0o777, 0o644, "chmod never follows the symlink to reach the external target");
    assert.equal(
      readFileSync(externalTarget, "utf8"),
      "not a deploy key — an unrelated file this symlink points at",
      "the external target's bytes are untouched",
    );
    assert.ok(
      !calls.some((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add"),
      "no add call — provisioning refused before ever reaching gh",
    );
    const warn = actions.find((a) => a.startsWith("deploy key: WARN"));
    assert.ok(warn, "expected a provisioning-failure WARN action line");
    assert.match(warn!, /not a regular file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (arm (a)): a pre-existing .pub file with no private half at a per-host slot is a collision — arm (a) advances to a numeric-suffixed sibling rather than overwriting it", async () => {
  const { run, calls } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [{ id: 7, title: "sapwood-worker" }], // routes into armAuthFailsStaleOrMismatch
  });
  const dir = tmpCwd();
  try {
    const staleSlotPub = join(dir, ".sapwood", "keys", "worker-deploy-key-test-host.pub");
    mkdirSync(dirname(staleSlotPub), { recursive: true });
    writeFileSync(staleSlotPub, "sentinel-preexisting-hostname-slot-pub");

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
    const expectedKeyPath = join(dir, ".sapwood", "keys", "worker-deploy-key-test-host-2");
    const addCall = calls.find((c) => c[0] === "repo" && c[1] === "deploy-key" && c[2] === "add");
    assert.ok(addCall, "gh repo deploy-key add must be called");
    assert.equal(
      addCall![3],
      `${expectedKeyPath}.pub`,
      "the fresh keypair is minted at the suffixed sibling slot, never the colliding one",
    );
    assert.equal(addCall![addCall!.indexOf("--title") + 1], expectedTitle);
    assert.equal(
      readFileSync(staleSlotPub, "utf8"),
      "sentinel-preexisting-hostname-slot-pub",
      "the pre-existing .pub at the colliding per-host slot is never touched",
    );
    assert.ok(actions.some((a) => a.includes(expectedTitle)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (AC2): a second run against an already-initialized repo WITH a real provisioned key reports ZERO create actions and leaves the key's bytes and modes unchanged", async () => {
  const dir = tmpCwd();
  const previousCwd = process.cwd();
  try {
    // First run: genuine fresh provisioning — a fake sshKeygen writes both real halves, and
    // this run's own action list (not a hand-built fixture) is what the second run reconciles
    // against.
    const { run: run1 } = fakeRun({
      labels: requiredLabels(cfg).map((l) => l.name),
      boardExists: true,
      boardOptions: ["Todo", "Ready", "In Progress", "Done"],
      deployKeyEntries: [],
    });
    const first = await init(cfg, {
      run: run1,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async (path) => {
        writeFileSync(path, "first-run-private-key");
        writeFileSync(`${path}.pub`, `${FAKE_PUB_KEY}\n`);
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.ok(
      first.actions.some((a) => /added write deploy key/.test(a)),
      "the first run actually provisions the key",
    );
    assert.ok(
      first.actions.some((a) => /wrote starter config/.test(a)),
      "the first run actually creates the starter config",
    );

    const keyPath = join(dir, ".sapwood", "keys", "worker-deploy-key");
    const privateBefore = readFileSync(keyPath, "utf8");
    const pubBefore = readFileSync(`${keyPath}.pub`, "utf8");
    const dirModeBefore = statSync(dirname(keyPath)).mode & 0o777;
    const fileModeBefore = statSync(keyPath).mode & 0o777;
    assert.equal(fileModeBefore, 0o600, "the first run already leaves the key at 0600");

    // Second run: loadConfig the file the first run actually wrote (unchanged by the deploy-key
    // step — #1105 — but still the config init's other steps need); the local anchor sidecar the
    // first run wrote under .sapwood/keys/ is what makes this a genuine RECONCILE against real
    // state, never a hand-built "already configured" fixture — the remote list below reflects the
    // first run's own registration (id 1, matching .pub).
    process.chdir(dir);
    const cfg2 = loadConfig(join(dir, "sapwood.config.yaml"));
    process.chdir(previousCwd);
    const { run: run2 } = fakeRun({
      labels: requiredLabels(cfg2).map((l) => l.name),
      boardExists: true,
      boardOptions: ["Todo", "Ready", "In Progress", "Done"],
      deployKeyEntries: [{ id: 1, title: "sapwood-worker", key: FAKE_PUB_KEY }],
    });
    const second = await init(cfg2, {
      run: run2,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: failSshKeygen,
      probeSshAuth: async () => ({ ok: true }),
    });
    assert.ok(
      second.actions.some((a) => /reconciled/.test(a) && /L1 active/.test(a)),
      "the second run genuinely reconciles green",
    );
    for (const verb of [/^wrote /, /^created /, /added write deploy key/, /appended/]) {
      assert.ok(
        !second.actions.some((a) => verb.test(a)),
        `the second run must report zero actions matching ${verb}, got: ${second.actions.join(" | ")}`,
      );
    }
    assert.equal(readFileSync(keyPath, "utf8"), privateBefore, "the second run never rewrites the private key bytes");
    assert.equal(readFileSync(`${keyPath}.pub`, "utf8"), pubBefore, "the second run never rewrites the .pub bytes");
    assert.equal(statSync(dirname(keyPath)).mode & 0o777, dirModeBefore, "the second run leaves the keys/ dir mode unchanged");
    assert.equal(statSync(keyPath).mode & 0o777, fileModeBefore, "the second run leaves the private key mode unchanged");
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (AC3 i): .sapwood existing as a regular file -> init refuses with a clear message, before any gh call", async () => {
  const dir = tmpCwd();
  try {
    writeFileSync(join(dir, ".sapwood"), "not a directory");
    let authCalled = false;
    let runCalled = false;
    const run: GhRunner = async () => {
      runCalled = true;
      return "";
    };
    await assert.rejects(
      () =>
        init(cfg, {
          run,
          getAuthStatus: async () => {
            authCalled = true;
            return OK_AUTH;
          },
          cwd: dir,
          ...nonInteractive,
        }),
      (e: unknown) => e instanceof InitError && /\.sapwood.*already exists.*not a directory/i.test(e.message),
    );
    assert.equal(authCalled, false, "the refusal happens before preflight — no gh auth check for a doomed init");
    assert.equal(runCalled, false, "the refusal happens before any label/milestone/board/deploy-key gh call");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (AC3 ii): .sapwood already existing as a DIRECTORY with unrelated content -> init proceeds and handles only its own files, no tree-level refusal or sweep", async () => {
  const { run } = fakeRun({
    labels: requiredLabels(cfg).map((l) => l.name),
    boardExists: true,
    boardOptions: ["Todo", "Ready", "In Progress", "Done"],
    deployKeyEntries: [],
  });
  const dir = tmpCwd();
  try {
    mkdirSync(join(dir, ".sapwood"), { recursive: true });
    writeFileSync(join(dir, ".sapwood", "operator-scratch.txt"), "not sapwood's own file");
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
      actions.some((a) => a.startsWith("runtime root:")),
      "init proceeded past the root check",
    );
    assert.equal(
      readFileSync(join(dir, ".sapwood", "operator-scratch.txt"), "utf8"),
      "not sapwood's own file",
      "unrelated content already sitting under .sapwood/ is left untouched — no tree-level refusal or sweep",
    );
    assert.equal(readFileSync(join(dir, ".sapwood", ".gitignore"), "utf8"), "*\n");
    assert.equal(existsSync(join(dir, ".sapwood", "keys", "worker-deploy-key")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (AC4): git status --porcelain in a temp git repo shows NOTHING under .sapwood/ after init — the key, its WAL-style siblings, and cache/ are all actually ignored", async () => {
  const dir = tmpCwd();
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    const { run } = fakeRun({
      labels: requiredLabels(cfg).map((l) => l.name),
      boardExists: true,
      boardOptions: ["Todo", "Ready", "In Progress", "Done"],
      deployKeyEntries: [], // fresh provisioning -> a real key lands under .sapwood/keys/
    });
    await init(cfg, {
      run,
      getAuthStatus: async () => OK_AUTH,
      cwd: dir,
      ...nonInteractive,
      sshKeygen: async (path) => {
        writeFileSync(path, "fake-private-key");
        writeFileSync(`${path}.pub`, "ssh-ed25519 AAAA fake");
      },
      probeSshAuth: async () => ({ ok: true }),
    });
    // WAL-style siblings + a cache file, matching what a live engine session actually leaves
    // under the SAME root — proves the root's `*` .gitignore covers more than just the files
    // this one init run happened to write.
    writeFileSync(join(dir, ".sapwood", "sapwood.sqlite"), "db");
    writeFileSync(join(dir, ".sapwood", "sapwood.sqlite-wal"), "wal");
    writeFileSync(join(dir, ".sapwood", "cache", "generated-probe.txt"), "probe");
    const status = execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });
    assert.doesNotMatch(status, /\.sapwood/, `git status --porcelain must show nothing under .sapwood/, got:\n${status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
