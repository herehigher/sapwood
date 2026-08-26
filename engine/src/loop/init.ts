// `sapwood init` — credible, idempotent, recovery-safe onboarding. Automates GitHub setup
// end-to-end — no manual "create the board by hand" step. Detect-before-create everywhere,
// so re-running is always safe.
//
// Steps: auth preflight -> user-vs-org -> ensure labels -> ensure milestones ->
// ensure ProjectV2 board (Status lanes) -> write starter config.
// The guard PreToolUse hook is built (guard.ts / guard-hook.ts) and wired live per session by
// worker.ts at dispatch time, not by init — init only reports that, and that guard.ts/hook
// wiring/security config are human-merge-only per CLAUDE.md.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ConfigSchema, engineAgentEmptyCiRequiredChecksError, type SapwoodConfig } from "../config/config.js";
// #1080: the deploy key moves under the shared runtime-root layout (`.sapwood/keys/`) instead of
// init's own pre-#1080 bare `data` directory — the same root `ensureRuntimeRoot` (#1077) already
// creates for every other state-touching command, so init's own root creation and its key
// placement can never drift onto two different notions of "the runtime root".
import {
  DEPLOY_KEY_BASENAME,
  defaultRuntimeRoot,
  ensureRuntimeRoot,
  findDeployKeyAnchor,
  keyIdSidecarPath,
  runtimePaths,
} from "../config/paths.js";
import type { OwnerKind } from "../forge/forge.js";
import { type GhRunner, gh, ghText } from "../forge/gh.js";
import { createMissingLabels, describeLabelDrift, type LabelSpec, normalizeLabel, taxonomyLabels } from "../forge/labels.js";
import { type LlmPingResult, probeDeployKeySsh, spawnSshKeygen } from "../roles/worker.js";
import { DOC_LINKS } from "../util/doc-links.js";

export interface InitDeps {
  run: GhRunner; // generic gh runner (label/milestone/api/graphql)
  getAuthStatus: () => Promise<string>; // `gh auth status` text (stdout+stderr)
  cwd: string; // where to write the starter config
  // #606: generates a fresh ed25519 keypair at `path` (writes `path` + `path.pub`, 0600). Default:
  // worker.ts's spawnSshKeygen (a real `ssh-keygen -t ed25519 -N "" -f <path>`) — init.ts itself
  // must not import node:child_process (worker.test.ts's #69 grep-invariant enumerates the only
  // four modules in the engine allowed to). Injectable so init.test.ts never shells out.
  sshKeygen: (path: string) => Promise<void>;
  // #606: the same SSH-auth preflight worker.ts's own L1 activation probes at dispatch time —
  // reused here (not re-implemented) so init's "preflight green" report and the engine's own
  // runtime preflight can never silently diverge on what "the key works" means.
  probeSshAuth: (path: string) => Promise<LlmPingResult>;
  // #606 gate② round 1 (owner ruling): true when init can prompt a human right now — the
  // auth-fails/stale/mismatch arm's (a)/(b) choice is only ever OFFERED when true; false (no
  // TTY — the ordinary autonomous/CI init invocation) silently defaults to (b), the no-write,
  // never-wedge path, while the WARN still names (a)'s manual steps. Default:
  // `process.stdin.isTTY`. Injectable so tests drive both arms without a real TTY.
  isInteractive: () => boolean;
  // #606 gate② round 1: prompts the operator with `question` (node:readline/promises) and
  // resolves the trimmed answer. Only ever called when isInteractive() is true. Injectable so
  // tests drive the (a)/(b) choice deterministically without a real terminal.
  promptOperator: (question: string) => Promise<string>;
  // #606 gate② round 1 (arm (a)): the local machine's hostname, used to mint a per-machine
  // deploy-key title (`sapwood-worker-<hostname>`) that stays collision-free across machines
  // sharing one repo. Default: node:os's hostname(). Injectable for deterministic tests.
  hostname: () => string;
}

const defaultDeps = (): InitDeps => ({
  run: gh,
  getAuthStatus: () => ghText(["auth", "status"]),
  cwd: process.cwd(),
  sshKeygen: spawnSshKeygen,
  probeSshAuth: probeDeployKeySsh,
  isInteractive: () => process.stdin.isTTY === true,
  promptOperator: async (question: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  },
  hostname: () => osHostname(),
});

// ---- pure helpers (unit-tested) -------------------------------------------------

/** Extract OAuth scopes from `gh auth status` text. Handles quoted and bare lists. */
export function parseAuthScopes(text: string): string[] {
  const line = text.split("\n").find((l) => /token scopes:/i.test(l));
  if (!line) return [];
  const after = line.slice(line.toLowerCase().indexOf("token scopes:") + "token scopes:".length);
  return [...after.matchAll(/[a-zA-Z][\w:-]*/g)].map((m) => m[0]);
}

/** Items in `desired` not present in `existing` (case-sensitive set difference). */
export function missing<T>(desired: readonly T[], existing: readonly T[]): T[] {
  const have = new Set(existing);
  return desired.filter((d) => !have.has(d));
}

export type { LabelSpec };

/** The label taxonomy the loop depends on, derived from config (no literals hidden in code).
 *  #379: also read by the ENGINE's startup reconcile (cli.ts's reconcileWorkflowLabels), so
 *  `sapwood init` and a running engine provision from exactly one list. */
export function requiredLabels(cfg: SapwoodConfig): LabelSpec[] {
  const l = cfg.labels;
  const base: LabelSpec[] = [
    ...taxonomyLabels(l.prefix),
    { name: l.inProgress, color: "0e8a16", description: "sapwood has claimed this issue and is working on it" },
    // #397: every escalation-tier description answers the same three questions a human staring at
    // the label needs — WHO writes it / WHAT the human must do / WHAT removing it does — inside
    // GitHub's 100-char description limit, and identical to the row in docs/guide/configuration.md
    // (init.test.ts pairs them, the same check #400 introduced for `hold`).
    { name: l.needsHuman, color: "5319e7", description: "sapwood has stopped and is waiting on a human decision; remove to resume" },
    { name: l.blocked, color: "5319e7", description: "sapwood or a human blocked this on something external; remove once it's resolved" },
    { name: l.reserve, color: "5319e7", description: "A human parked this out of sapwood's work queue; remove to make it available again" },
    {
      name: l.verifyNa,
      color: "c5def5",
      description: "Not verifiable by automated tests; goes through the documentation-review path instead",
    },
    { name: l.planApproved, color: "0e8a16", description: "This issue's verification plan has been reviewed and approved" },
    { name: l.originAgent, color: "bfd4f2", description: "This issue was created automatically, not by a human" },
    { name: l.split, color: "fbca04", description: "Marks this issue for splitting into smaller issues" },
    {
      name: l.decomposed,
      color: "6e7781",
      description: "sapwood retired this parent in favor of smaller issues; kept open for tracking only",
    },
    // #212: round-pool membership — applied by the aligning phase's pool-selection pass,
    // cleared by the engine at round close (never by a session — see removeRoundPoolLabel).
    { name: l.roundPool, color: "5319e7", description: "Selected for sapwood's current work round" },
    // #397 bucket 2 — the ONE meaning `needs-human` could never express: not "the machine is
    // stuck", but "this PR's merge decision belongs to a human." Written once, on the PR, and
    // never re-evaluated, so the description says the loop will not take it back.
    {
      name: l.humanMergeOnly,
      color: "b60205",
      description: "sapwood marked this PR for human merge; a human must merge it and sapwood never removes this",
    },
    // #399: the PR-side lane-state mirror. The description answers the same three questions every
    // escalation-tier description does — WHO writes it / WHAT it means / WHAT removal does — and
    // the answer to the third is "nothing you need to do": the engine removes it itself when the
    // lane ends. Identical to the row in docs/guide/configuration.md (the #397/#400 pairing check).
    {
      name: l.laneState,
      color: "0e8a16",
      description: "sapwood is actively working on this PR; removed automatically when done",
    },
    // #397 class 6 — explicitly NOT an escalation, so the description says so: nobody is on the
    // hook, it just keeps a plan-less issue off every queue until a plan exists.
    {
      name: l.planless,
      color: "6e7781",
      description: "sapwood found no verification plan yet; add one, then remove this label",
    },
  ];
  // #248 review round 1 (G2): the shipped `escalation.holdLabels` default (sapwood:hold) is
  // otherwise unusable on a clean repo — nothing ever creates the GitHub label itself, so a
  // human trying to apply it from the PR UI finds no such label to pick. Provisioning the REPO
  // label here is not "writing a hold" (write-side asymmetry, #248's own doctrine, is about the
  // engine applying a hold TO an issue/PR — creating the label definition itself is the same
  // one-time repo-setup act `sapwood init` already does for needsHuman/blocked/etc above).
  // #658 review round 2 (B): this used to also dedupe against `base` (every workflow + taxonomy
  // name), because config load's collision guard checked `holdLabels` against every OTHER
  // protected/workflow label but NOT the fixed type:*/prio:* taxonomy — a `holdLabels` entry
  // equal to a taxonomy name could reach here. Round 2 closed that gap AT THE SOURCE
  // (config.ts's exhaustive collision guard now rejects holdLabels x taxonomy, same as it always
  // rejected holdLabels x workflow), so `cfg.escalation.holdLabels` can no longer contain any name
  // in `base` by the time it reaches this function — dedup-against-`base` is now dead code,
  // deleted rather than kept as a defense against a config state parsing no longer allows. The one
  // case still reachable here — two `holdLabels` ENTRIES that normalize to the same name (config
  // load only rejects a `holdLabels` entry colliding with something ELSE, not two entries
  // colliding with EACH OTHER, since both assert the identical fact rather than aliasing two
  // different ones) — keeps its dedupe, now scoped to `holdLabels` alone.
  const haveNames = new Set<string>();
  const holdSpecs: LabelSpec[] = [];
  for (const name of cfg.escalation.holdLabels) {
    const key = normalizeLabel(name);
    if (haveNames.has(key)) continue;
    haveNames.add(key);
    // #400: the description carries the whole contract — purpose, carrier, what removal does, and
    // that an issue is NOT a carrier. Kept identical in docs/guide/configuration.md (init.test.ts pairs
    // them) and inside GitHub's 100-char label-description limit.
    holdSpecs.push({
      name,
      color: "fbca04",
      description: "A human is reviewing this PR — automation pauses; remove to resume. No effect on issues.",
    });
  }
  return [...base, ...holdSpecs];
}

// ---- gh-backed steps (integration-level; thin) ----------------------------------

export class InitError extends Error {}

/** Throw an actionable error if not authenticated or missing the `project` scope. */
export async function preflight(getAuthStatus: () => Promise<string>): Promise<void> {
  const text = await getAuthStatus();
  // A "Token scopes:" line only appears for an authenticated account, so its presence is
  // the auth signal — robust even when `gh auth status` lists multiple hosts and another
  // host is "not logged in" (a global /not logged in/ check would false-reject here).
  if (!/token scopes:/i.test(text)) {
    throw new InitError("not logged in to GitHub — run: gh auth login");
  }
  if (!parseAuthScopes(text).includes("project")) {
    throw new InitError("missing `project` token scope — run: gh auth refresh -s project");
  }
}

async function ensureLabels(cfg: SapwoodConfig, run: GhRunner, repo: string): Promise<string[]> {
  return createMissingLabels(run, repo, requiredLabels(cfg));
}

async function ensureMilestones(cfg: SapwoodConfig, run: GhRunner, repo: string): Promise<string[]> {
  if (cfg.milestones.length === 0) return [];
  // state=all so a closed milestone isn't re-created (would 422). `--jq '.[].title'` (no
  // array wrap) emits one title per line, which survives --paginate concatenating pages
  // — a wrapped `[...]` per page would break JSON.parse past 30 milestones.
  const out = await run(["api", `repos/${repo}/milestones?state=all`, "--paginate", "--jq", ".[].title"]);
  const existing = out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const toCreate = missing(cfg.milestones, existing);
  for (const title of toCreate) {
    await run(["api", `repos/${repo}/milestones`, "-f", `title=${title}`]);
  }
  return toCreate;
}

// ---- ProjectV2 board (automated end-to-end; no manual creation step) -------------------------

export interface BoardOption {
  name: string;
  color: string; // ProjectV2 single-select color enum (GRAY, BLUE, ...)
  description: string;
  id?: string; // existing option's GraphQL ID — see setStatusOptionsArgs for why this matters
}
interface BoardState {
  exists: boolean;
  statusFieldId?: string;
  options: BoardOption[];
}

/** Query the configured ProjectV2 + its Status single-select options (name + color). */
async function queryBoard(cfg: SapwoodConfig, ownerKind: OwnerKind, run: GhRunner): Promise<BoardState> {
  const root = ownerKind === "org" ? "organization" : "user";
  // statusField is bound as a variable, not inlined, so a field name is never query text.
  const q = `query($owner:String!,$num:Int!,$status:String!){
    ${root}(login:$owner){ projectV2(number:$num){ id
      field(name:$status){ ... on ProjectV2SingleSelectField { id options{ id name color description } } } } } }`;
  // string vars via -f (raw); only the Int! `num` needs -F. -F magic-types @file/numeric,
  // which could misread an owner/status value starting with '@' or looking numeric.
  const out = await run([
    "api",
    "graphql",
    "-f",
    `query=${q}`,
    "-f",
    `owner=${cfg.board.owner}`,
    "-F",
    `num=${cfg.board.projectNumber}`,
    "-f",
    `status=${cfg.board.statusField}`,
  ]);
  const proj = JSON.parse(out)?.data?.[root]?.projectV2 as { id: string; field?: { id: string; options: BoardOption[] } | null } | null;
  if (!proj) return { exists: false, options: [] };
  return {
    exists: true,
    ...(proj.field ? { statusFieldId: proj.field.id } : {}),
    options: proj.field?.options ?? [],
  };
}

/**
 * Ensure the ProjectV2 board has the configured Status lanes. If the board does not exist
 * at the configured number, report it (creation needs an explicit step so the user wires
 * the new number into config) rather than silently creating a mismatched board.
 */
async function ensureBoard(cfg: SapwoodConfig, ownerKind: OwnerKind, run: GhRunner): Promise<string[]> {
  const board = await queryBoard(cfg, ownerKind, run);
  const desired = [cfg.board.status.backlog, cfg.board.status.ready, cfg.board.status.inProgress, cfg.board.status.done];
  if (!board.exists) {
    return [
      `board: no ProjectV2 #${cfg.board.projectNumber} found for ${cfg.board.owner}. ` +
        `Create one (gh project create --owner ${cfg.board.owner} --title sapwood), set ` +
        `board.projectNumber in config, and re-run init to provision its Status lanes (${desired.join(", ")}).`,
    ];
  }
  if (!board.statusFieldId) {
    return [
      `board: ProjectV2 #${cfg.board.projectNumber} has no "${cfg.board.statusField}" single-select field; add it in the UI, then re-run.`,
    ];
  }
  const need = missing(
    desired,
    board.options.map((o) => o.name),
  );
  // Exact match: every desired lane already exists. Make NO mutation call at all — even a
  // no-op-looking updateProjectV2Field(singleSelectOptions:[...]) reassigns every option's
  // ID (confirmed via `gh api graphql` schema introspection: ProjectV2SingleSelectFieldOptionInput.id
  // is the ONLY thing that preserves an option's identity across the call), which silently
  // wipes every item's Status on the board (issue #37). Idempotent re-runs must be a true no-op.
  if (need.length === 0) return [];
  // updateProjectV2Field replaces the FULL option set, so resend the existing lanes with
  // their existing `id` (preserving identity + colors/descriptions — see setStatusOptionsArgs)
  // plus the new ones (GRAY, no id — the API assigns a fresh id for those).
  const full: BoardOption[] = [...board.options, ...need.map((name) => ({ name, color: "GRAY", description: "" }))];
  await run(setStatusOptionsArgs(board.statusFieldId, full));
  return need.map((n) => `board: added Status lane "${n}"`);
}

const VALID_OPTION_COLORS = new Set(["GRAY", "BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PINK", "PURPLE"]);

/**
 * argv for setting the full single-select option list on a ProjectV2 Status field.
 * `color` is a GraphQL enum (not a String), so options are inlined: names are JSON-escaped
 * and colors are validated against the known enum set (defensive — they come from the API
 * or our own GRAY default). The field id is bound as a variable.
 *
 * Each existing option MUST carry its `id` (per `ProjectV2SingleSelectFieldOptionInput.id`,
 * confirmed via schema introspection: "Include this to preserve the option's identity during
 * updates, preventing item field values from being cleared") — omitting it, even while
 * resending the exact same name/color/description, makes the API mint a brand-new id and
 * every item currently set to that option silently reverts to "No Status" (issue #37). A
 * genuinely new option has no `id` yet, so it's left out and the API assigns one.
 */
export function setStatusOptionsArgs(fieldId: string, options: BoardOption[]): string[] {
  const inline = options
    .map((o) => {
      const color = VALID_OPTION_COLORS.has(o.color) ? o.color : "GRAY";
      const id = o.id ? `id:${JSON.stringify(o.id)}, ` : "";
      return `{${id}name:${JSON.stringify(o.name)}, color:${color}, description:${JSON.stringify(o.description)}}`;
    })
    .join(", ");
  const mutation = `mutation($f:ID!){
    updateProjectV2Field(input:{fieldId:$f, singleSelectOptions:[${inline}]}){
      projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`;
  return ["api", "graphql", "-f", `query=${mutation}`, "-F", `f=${fieldId}`];
}

/** Write the starter config next to cwd if none exists. Returns the path written, or null. */
function ensureConfig(cwd: string): string | null {
  const candidates = ["sapwood.config.yaml", "sapwood.config.yml", "sapwood.config.json"];
  if (candidates.some((c) => existsSync(join(cwd, c)))) return null;
  const target = join(cwd, "sapwood.config.yaml");
  writeFileSync(target, sampleConfig());
  return target;
}

function sampleConfig(): string {
  // Ship the target-repository example with the package.
  //
  // #801: neither this fallback's own inline text below NOR the shipped example.yaml sets
  // ci.requiredChecks — deliberately: init cannot know a real CI check name for an arbitrary
  // target repository, and writing a plausible-looking WRONG one would silently defeat #784's
  // startup refusal (the check would pass, but no real CheckRun would ever match, so PRs would
  // still queue forever — just without the loud warning). init()'s own caller surfaces this gap
  // as an explicit WARN action instead — see init()'s own comment at its `ensureConfig` call site.
  //
  // #1032: two on-disk locations, tried in order — an npm install only ever has the first.
  // `engine/`'s own copy is `prepack`-derived from the second (the monorepo's canonical file,
  // one level above `engine/`) so a clone-and-build checkout still finds it via the second
  // candidate even though `prepack` never ran there.
  const here = dirname(fileURLToPath(import.meta.url));
  const packageLocal = join(here, "..", "..", "sapwood.config.example.yaml");
  if (existsSync(packageLocal)) return readFileSync(packageLocal, "utf8");
  const repoRoot = join(here, "..", "..", "..", "sapwood.config.example.yaml");
  if (existsSync(repoRoot)) return readFileSync(repoRoot, "utf8");
  return "board:\n  owner: CHANGEME\n  repo: CHANGEME\n  projectNumber: 0\n";
}

// ---- #1105 (see docs/security/credential-tiers.md): L1 scoped-worker-identity deploy-key
// provisioning, anchored on a LOCAL (key file, id sidecar) pair under `.sapwood/keys/`. The
// engine never invokes or scripts remote deploy-key deletion — the bare remote title may validly
// belong to a different machine/operator, so a foreign or stale key is only ever surfaced in a
// WARN for a HUMAN to review, never touched by this file. ----------------------------------

// Exported (#671): deploy-key-startup-check.ts's "missing/unreadable key file" arm reuses this
// as the generic title argument to deployKeyProvisioningFailedAction below — the same guidance
// string `sapwood init` itself would produce for the same failure shape.
export const DEPLOY_KEY_TITLE = "sapwood-worker";

// #1080: the ONE place `cwd` is turned into "where the deploy key(s) live" — keeps every
// key-path construction below (base path, per-host candidates, numeric-suffixed siblings)
// agreeing with `runtimePaths()` by construction.
function deployKeysDir(cwd: string): string {
  return runtimePaths(defaultRuntimeRoot(cwd)).keysDir;
}

// #1080: injectable fs seam for enforceDeployKeyPermissions below — the same DI pattern
// paths.ts's own RuntimeRootFsOps uses (a spy substituted for the real node:fs calls). This is
// the only way to deterministically exercise a chmod/lstat FAILURE in a test: real permission
// tricks (chmod a directory unwritable, run as non-root, ...) behave differently per OS/CI
// runner and would make the test flaky or unrunnable rather than a reliable regression pin.
export interface DeployKeyPermissionsFsOps {
  mkdir: (dir: string) => void;
  lstat: (path: string) => import("node:fs").Stats;
  chmod: (path: string, mode: number) => void;
}

export const realDeployKeyPermissionsFsOps: DeployKeyPermissionsFsOps = {
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  lstat: (path) => lstatSync(path),
  chmod: (path, mode) => chmodSync(path, mode),
};

// #1080: repairs the key's directory (0700) and, when a private key file is present, its own
// mode (0600) — called on every path that can leave a key on disk (fresh generation, reuse,
// reconcile), since neither a bare `mkdir`'s own `mode` option nor ssh-keygen's own default is
// trusted to land on the exact mode regardless of the caller's umask. Uses `lstat` (never
// dereferenced) to confirm each entry is what it claims to be BEFORE chmodding it: `chmod`
// follows symlinks the same as a bare shell `chmod` (not `chmod -h`), so chmodding whatever a
// mere existence check reports present could reach through a symlink and mutate an unrelated
// file's permissions, or strip the executable bit off a directory standing in for the key file.
// Every failure — a collision (wrong entry type) or a genuine I/O error from any of the three
// calls (mkdir/lstat/chmod) — is reported back to the caller as `{ ok: false, reason }` instead
// of throwing, so a caller that must never let this abort the whole run (reconcile) can degrade
// to a WARN rather than crash `init()` outright.
function enforceDeployKeyPermissions(
  keyPath: string,
  fs: DeployKeyPermissionsFsOps = realDeployKeyPermissionsFsOps,
): { ok: true } | { ok: false; reason: string } {
  const dir = dirname(keyPath);
  try {
    fs.mkdir(dir);
  } catch (e) {
    return { ok: false, reason: `could not create ${dir}: ${e instanceof Error ? e.message : String(e)}` };
  }
  let dirStat: import("node:fs").Stats;
  try {
    dirStat = fs.lstat(dir);
  } catch (e) {
    return { ok: false, reason: `could not stat ${dir}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!dirStat.isDirectory()) {
    return { ok: false, reason: `${dir} exists but is not a real directory (a symlink or other type) — refusing to chmod it` };
  }
  try {
    fs.chmod(dir, 0o700);
  } catch (e) {
    return { ok: false, reason: `could not chmod ${dir} to 0700: ${e instanceof Error ? e.message : String(e)}` };
  }

  let keyStat: import("node:fs").Stats | undefined;
  try {
    keyStat = fs.lstat(keyPath);
  } catch (e) {
    // ENOENT alone means "nothing at keyPath yet" — every OTHER lstat failure (EACCES, ELOOP,
    // ...) is a reported failure, never silently read as absence: treating an unreadable path as
    // absent would send the caller on to attempt ssh-keygen against a path this process cannot
    // even stat, rather than surfacing the real problem.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true };
    return { ok: false, reason: `could not stat ${keyPath}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!keyStat.isFile()) {
    return { ok: false, reason: `${keyPath} exists but is not a regular file (a directory or symlink) — refusing to chmod it` };
  }
  try {
    fs.chmod(keyPath, 0o600);
  } catch (e) {
    return { ok: false, reason: `could not chmod ${keyPath} to 0600: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true };
}

// #1080: the fresh/reuse/arm(a) provisioning call sites already run inside a try/catch that
// degrades ANY failure to the same guidance-carrying WARN (deployKeyProvisioningFailedAction) —
// this just turns a permission-repair collision into a thrown Error so it takes that identical
// path, rather than requiring each call site to check the result inline.
function enforceDeployKeyPermissionsOrThrow(keyPath: string, fs: DeployKeyPermissionsFsOps = realDeployKeyPermissionsFsOps): void {
  const result = enforceDeployKeyPermissions(keyPath, fs);
  if (!result.ok) throw new Error(result.reason);
}

export interface DeployKeyListEntry {
  id: number;
  title: string;
  // #606 gate② round 2 (R3-1): the registered PUBLIC key content, when `gh` reports it
  // (`--json id,title,key`) — optional because not every caller requests it (the id/title-only
  // callers have no use for it and keep the smaller argv/response). Used by reconcileDeployKey
  // to prove the (path, id) pair is genuinely the SAME key, not merely "an id that happens to be
  // registered" plus "a local key that happens to authenticate" independently.
  key?: string;
  // Whether this deploy key is registered read-only (no push access) — requested via
  // `--json ...,readOnly` only by the startup tier check (deploy-key-startup-check.ts), which
  // must refuse L1 for an anchor that authenticates but cannot push. Optional for the same
  // reason `key` is: most callers here never request the field.
  readOnly?: boolean;
}

/** #606 gate② round 1 (P1-1): `gh repo deploy-key list --json <fields>` — REQUIRES `--json`
 *  first (confirmed by a live probe on this repo: `--jq` without it fails "cannot use --jq
 *  without specifying --json"). This is DIFFERENT from `gh api ...--jq`'s own idiom (this file's
 *  ensureMilestones/checkDefaultBranchProtectionAction both use `gh api --jq` with no `--json` —
 *  legal there because `gh api`'s whole HTTP response already IS the JSON payload being
 *  filtered; `gh repo deploy-key list` is a table-output "list" command whose `--jq` needs an
 *  explicit `--json <fields>` selection first). Parses `id`/`title` (required) and `key`
 *  (optional — present only when the caller requested it) — the owner ruling's local (path, id)
 *  anchor needs ids to reconcile against, which the superseded title-only `--jq '.[].title'`
 *  parse could never supply. */
export function parseDeployKeys(text: string): DeployKeyListEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: DeployKeyListEntry[] = [];
  for (const entry of parsed) {
    const id = (entry as { id?: unknown } | null)?.id;
    const title = (entry as { title?: unknown } | null)?.title;
    const key = (entry as { key?: unknown } | null)?.key;
    const readOnly = (entry as { readOnly?: unknown } | null)?.readOnly;
    if (typeof id === "number" && typeof title === "string") {
      out.push({
        id,
        title,
        ...(typeof key === "string" ? { key } : {}),
        ...(typeof readOnly === "boolean" ? { readOnly } : {}),
      });
    }
  }
  return out;
}

/** #606 gate② round 2 (R3-1): normalizes an SSH public-key line to its `<type> <base64>` prefix
 *  — the two tokens that identify the key material itself — dropping any trailing comment and
 *  collapsing surrounding whitespace, so a locally-generated `.pub` file (which carries whatever
 *  comment `ssh-keygen` wrote) compares equal to the SAME key as GitHub echoes it back (which may
 *  carry no comment, or a different one). */
function normalizePublicKey(raw: string): string {
  const [type, base64] = raw.trim().split(/\s+/);
  return type && base64 ? `${type} ${base64}` : raw.trim();
}

/** #606 gate② round 1: true for the base title OR any per-machine title the auth-fails/stale/
 *  mismatch arm's choice (a) mints (`sapwood-worker-<hostname>`, optionally further suffixed —
 *  see pickFreshArmAKeySlot) — used ONLY to detect "is there ANY sapwood-provisioned deploy key
 *  already on this repo" so fresh provisioning doesn't register a colliding second base-titled
 *  key. This is explicitly NOT an ownership check — ownership is decided by the LOCAL (path, id)
 *  anchor alone, per the owner ruling (a title is never authoritative for "mine"). */
function isSapwoodWorkerTitle(title: string): boolean {
  return title === DEPLOY_KEY_TITLE || title.startsWith(`${DEPLOY_KEY_TITLE}-`);
}

/** #606 gate② round 1 (arm (a)): sanitizes a hostname into the suffix of a per-machine deploy-key
 *  title/filename — lowercase alnum/dash only, collapsed, trimmed of leading/trailing dashes, so
 *  the result is safe both as a GitHub deploy-key title and as isSapwoodWorkerTitle's own prefix
 *  match. Falls back to "host" for a hostname that sanitizes to nothing (e.g. an all-symbol
 *  name) — the title must never collapse back to the bare, collision-prone `sapwood-worker`. */
export function sanitizeHostnameForKeyTitle(hostname: string): string {
  const cleaned = hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "host";
}

const MAX_ARM_A_SLOT_ATTEMPTS = 1000;

/** #606 gate② round 2 (R3-1), round 3 (item 3): arm (a) mints a FRESH keypair, always — it must
 *  never reuse whatever happens to already be sitting at the per-host path (a previous
 *  interrupted run) or register under a per-host title already claimed on the repo (foreign —
 *  same never-touch rule as any other unrecognized remote key). Walks `<hostComponent>`,
 *  `<hostComponent>-2`, `<hostComponent>-3`, ... and returns the first suffix where the local key
 *  path AND its `.pub` counterpart are BOTH free AND the title isn't among `knownRemoteTitles`
 *  (#1080: EITHER half existing is a collision — ssh-keygen would silently overwrite whichever
 *  half is missing, so a slot is only "free" when neither half is there); path and title always
 *  share the same suffix. `knownRemoteTitles` should be as fresh as practical (see its caller)
 *  since an interactive prompt can leave an arbitrary gap between the last remote read and this
 *  call.
 *
 *  Round 3 fix: exhaustion (every one of MAX_ARM_A_SLOT_ATTEMPTS candidates already taken) now
 *  THROWS rather than falling back to a synthesized candidate — a round-2 fallback re-derived a
 *  "fresh" path/title from `Date.now()` WITHOUT re-checking either the local-path-free or the
 *  remote-title-free condition (so it could silently collide with exactly the thing this
 *  function exists to avoid), and depended on wall-clock time besides. The caller catches this
 *  the same way it catches every other provisioning failure (deployKeyProvisioningFailedAction —
 *  WARN, degrade to L0), so exhaustion is reported honestly instead of risking a silent
 *  collision. */
export function pickFreshArmAKeySlot(
  cwd: string,
  hostComponent: string,
  knownRemoteTitles: ReadonlySet<string>,
): { path: string; title: string } {
  for (let n = 1; n <= MAX_ARM_A_SLOT_ATTEMPTS; n++) {
    const candidateHost = n === 1 ? hostComponent : `${hostComponent}-${n}`;
    const path = join(deployKeysDir(cwd), `${DEPLOY_KEY_BASENAME}-${candidateHost}`);
    const title = `${DEPLOY_KEY_TITLE}-${candidateHost}`;
    if (!existsSync(path) && !existsSync(`${path}.pub`) && !knownRemoteTitles.has(title)) return { path, title };
  }
  throw new Error(
    `could not find a free per-machine deploy-key slot for "${hostComponent}" after ${MAX_ARM_A_SLOT_ATTEMPTS} numeric-suffixed attempts — every candidate path/title is already taken`,
  );
}

/** #606 gate② round 1 guidance-carrying WARN (#554 pattern): fired whenever ssh-keygen/`gh repo
 *  deploy-key add` fails for ANY reason — no repo-admin scope is the expected cause, but this
 *  deliberately doesn't try to classify the gh error text to confirm that specifically (doctrine:
 *  gh's own exit failure is already an authoritative signal that provisioning didn't happen;
 *  guessing WHY from free text would be the inferred-text case this repo's doctrine treats as a
 *  last resort, not a first one). Names the exact manual steps + a docs anchor; the engine stays
 *  fully functional at L0 either way — never a startup failure. Also the "degrade (b)-style"
 *  landing spot for a post-add id-resolution ambiguity (R3-1) — a zero-or-multiple-new-ids
 *  result throws into the same catch block that reaches this function, so it reads and behaves
 *  exactly like any other provisioning failure. */
// Exported (#671): deploy-key-startup-check.ts's "missing/unreadable key file" arm reuses this
// EXACT wording rather than writing a third guidance variant — see that module's own doc.
export function deployKeyProvisioningFailedAction(repo: string, keyPath: string, title: string, e: unknown): string {
  const reason = (e instanceof Error ? e.message : String(e)).split("\n")[0]?.trim() || "unknown error";
  return (
    `deploy key: WARN — could not provision a write deploy key for ${repo} (${reason}). This usually means the ` +
    `operator's gh token lacks repo admin. With worker.credentialTier: L0 (the default) this has no effect on ` +
    `dispatch; with L1, "sapwood run" refuses to start until it succeeds. To enable L1 by hand: (1) run ` +
    `\`ssh-keygen -t ed25519 -N "" -f ${keyPath}\`; (2) in the repo's Settings -> Deploy keys, add ` +
    `${keyPath}.pub with write access allowed, title "${title}"; (3) write the id GitHub assigns it into ` +
    `${keyIdSidecarPath(keyPath)} (mode 0600) — or simply re-run "sapwood init" once repo-admin is available, ` +
    `which does all of this automatically; (4) re-run "sapwood init" to confirm the preflight. See ` +
    `<${DOC_LINKS.security}>'s worker credential tiers.`
  );
}

/** #606 gate② round 1 guidance-carrying WARN: the preflight-fail arm — the key IS registered (or
 *  was just added) but SSH auth against it didn't succeed (host-key/network/local key-material
 *  issue). Same "never wedge, name the fix" contract as every other #554-pattern WARN here. */
// Exported (#671): deploy-key-startup-check.ts's "preflight fails" arm reuses this EXACT wording
// rather than writing a third guidance variant — see that module's own doc.
export function deployKeyPreflightFailedAction(keyPath: string, detail: string | undefined): string {
  return (
    `deploy key: WARN — SSH auth preflight failed for ${keyPath}${detail ? `: ${detail}` : ""}. With ` +
    `worker.credentialTier: L0 (the default) this has no effect on dispatch; with L1, "sapwood run" refuses to ` +
    `start until it passes. Fix: confirm ${keyPath} is a readable private key matching the deploy key registered ` +
    `on the repo, then re-run "sapwood init" to re-check the preflight. See <${DOC_LINKS.security}>'s worker ` +
    `credential tiers.`
  );
}

/** #606 gate② round 1 (P1-1): registers `title` as a deploy key for `repo` and returns the id
 *  GitHub assigned it — WITHOUT trusting a title match (a stale/duplicate/racing title could
 *  match the WRONG entry — R3-1). Captures the full id set via `list --json id,title` BEFORE the
 *  add, the same shape AFTER, and returns whichever id is new. Throws when the add itself fails,
 *  or when the before/after diff doesn't yield EXACTLY ONE new id — zero (the add reported
 *  success but nothing new showed up) or more than one (a raced/duplicate provisioning makes the
 *  new id ambiguous) are both treated by every caller as an ordinary provisioning failure (WARN +
 *  degrade to L0, `deployKeyProvisioningFailedAction`), never a thrown error escaping this file. */
async function addDeployKeyCapturingNewId(run: GhRunner, repo: string, keyPath: string, title: string): Promise<number> {
  const before = parseDeployKeys(await run(["repo", "deploy-key", "list", "-R", repo, "--json", "id,title"]));
  const beforeIds = new Set(before.map((k) => k.id));
  await run(["repo", "deploy-key", "add", `${keyPath}.pub`, "-R", repo, "--allow-write", "--title", title]);
  const after = parseDeployKeys(await run(["repo", "deploy-key", "list", "-R", repo, "--json", "id,title"]));
  const newIds = after.filter((k) => !beforeIds.has(k.id));
  if (newIds.length !== 1) {
    throw new Error(
      newIds.length === 0
        ? "deploy key add reported success but no new id appeared in the post-add list"
        : `deploy key add reported success but ${newIds.length} new ids appeared in the post-add list — cannot determine which is ours`,
    );
  }
  return newIds[0]!.id;
}

// The key (and its id sidecar below) lives under the runtime root's own self-ignoring
// `.gitignore` (`*`, written by `ensureRuntimeRoot`), so no rule ever needs appending to the
// repo's own `.gitignore` here; this file also never removes an existing rule from a user's
// `.gitignore`.

/** Records the local (key, id) anchor as a sidecar file beside the key itself. A plain
 *  positive-integer text file, not YAML/JSON — nothing here is ever hand-edited or re-parsed as
 *  a config, so there is no format to keep stable. Ceiling: holds exactly one numeric id, nothing
 *  more. Upgrade trigger: move to a versioned structured format the day the anchor needs a second
 *  field. Created with mode 0600 directly (no separate ambient-mode window between write and
 *  chmod) and chmodded again afterward via the same injectable fs seam enforceDeployKeyPermissions
 *  uses, since the create-time mode is still subject to the process umask. Throws on any
 *  write/chmod failure — every caller wraps this in its own try/catch, so a sidecar-persistence
 *  failure is reported as an ordinary provisioning failure, never an escape past the
 *  WARN-and-degrade contract every other step here has. */
function writeDeployKeyIdSidecar(keyPath: string, keyId: number, fs: DeployKeyPermissionsFsOps = realDeployKeyPermissionsFsOps): void {
  const idPath = keyIdSidecarPath(keyPath);
  writeFileSync(idPath, `${keyId}\n`, { mode: 0o600 });
  fs.chmod(idPath, 0o600);
}

/** #606 gate② round 1 (P2-7), round 2 (R3-5): distinguishes protected / confirmed-unprotected /
 *  cannot-verify, checking BOTH the legacy branch-protection endpoint and (when that legacy
 *  endpoint 404s) rulesets. The fix-carrying WARN only fires for a CONFIRMED-unprotected repo
 *  (legacy endpoint 404, AND no ruleset covers the branch either); anything else — a failure to
 *  even READ the default branch, a non-404 error from the legacy endpoint (403/plan-limit/
 *  network/an unclassifiable error), or a failure reading rulesets — gets a DISTINCT cannot-
 *  verify WARN rather than being read as "confirmed unprotected". Parses gh error text MINIMALLY
 *  (does a 3-digit HTTP status code appear at all) — no deeper classification, per this file's
 *  doctrine of trusting gh's own authoritative signal over inferred text. */
async function checkDefaultBranchProtectionAction(run: GhRunner, repo: string): Promise<string[]> {
  const cannotVerify = (reason: string): string[] => [
    `deploy key: WARN — cannot verify branch protection for ${repo} (${reason}). If this repo's plan cannot ` +
      `expose branch-protection status via the API, treat the default branch as UNPROTECTED and add a ` +
      `protection rule (repo Settings -> Branches) requiring the merge gate this engine already drives PRs ` +
      `through.`,
  ];
  let branch: string;
  try {
    const out = (await run(["api", `repos/${repo}`, "--jq", ".default_branch"])).trim();
    if (!out) return cannotVerify(`repos/${repo} returned no default_branch`);
    branch = out;
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).split("\n")[0]?.trim() || "unknown error";
    return cannotVerify(`could not read its default branch: ${message}`);
  }
  try {
    await run(["api", `repos/${repo}/branches/${branch}/protection`]);
    return [`deploy key: default branch "${branch}" on ${repo} is protected`];
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).split("\n")[0]?.trim() || "unknown error";
    const status = message.match(/\b(\d{3})\b/)?.[1];
    if (status !== "404") return cannotVerify(`for "${branch}": ${message}`);
    // Legacy protection is absent — this repo's plan may still enforce a RULESET on the branch
    // instead (rulesets are a separate GitHub feature the legacy endpoint doesn't report at
    // all), so check that before declaring confirmed-unprotected.
    try {
      const rulesetsRaw = await run(["api", `repos/${repo}/rules/branches/${branch}`]);
      const rulesets: unknown = JSON.parse(rulesetsRaw);
      if (Array.isArray(rulesets) && rulesets.length > 0) {
        return [`deploy key: default branch "${branch}" on ${repo} is protected (by a ruleset)`];
      }
    } catch (e2) {
      const message2 = (e2 instanceof Error ? e2.message : String(e2)).split("\n")[0]?.trim() || "unknown error";
      return cannotVerify(`legacy protection absent for "${branch}", and its ruleset status could not be read: ${message2}`);
    }
    return [
      `deploy key: WARN — default branch "${branch}" on ${repo} has NO branch protection rule (checked both the ` +
        `legacy branch-protection endpoint and rulesets covering the branch). An L1 deploy key can push directly ` +
        `to it (a stolen key's capability equals the granted capability — git push to this repo — but branch ` +
        `protection is still the backstop against the WORKER itself pushing straight to ${branch}). Fix: add a ` +
        `branch protection rule for "${branch}" (repo Settings -> Branches) requiring the merge gate this engine ` +
        `already drives PRs through.`,
    ];
  }
}

/** The reconcile-failure / no-local-anchor state. A remote title is never authoritative for
 *  "mine" — a `sapwood-worker`-titled key may validly belong to a different machine/operator, so
 *  this machine only ever ADDS a new key of its own, never deletes or overwrites a remote or
 *  existing local one; a WARN-only outcome (choice (b), or no TTY) touches no file, so the next
 *  `sapwood init` run reconciles against the same anchor again and reports the same WARN —
 *  honest non-convergence rather than a false promise. */
async function armAuthFailsStaleOrMismatch(
  run: GhRunner,
  repo: string,
  cwd: string,
  staleForeignKeys: DeployKeyListEntry[],
  reasons: string[],
  deps: Pick<InitDeps, "sshKeygen" | "probeSshAuth" | "isInteractive" | "promptOperator" | "hostname">,
  permissionsFs: DeployKeyPermissionsFsOps = realDeployKeyPermissionsFsOps,
): Promise<string[]> {
  const actions: string[] = [];

  const reasonText = reasons.length > 0 ? reasons.join("; ") : "no local (key, id) anchor recorded for this machine";
  const staleNote =
    staleForeignKeys.length > 0
      ? ` Existing sapwood-titled key(s) already on ${repo} — left untouched (verify/clean up by hand if any are ` +
        `stale): ${staleForeignKeys.map((k) => `"${k.title}" (id ${k.id})`).join(", ")}.`
      : "";
  const manualSteps =
    `To register an additional per-machine key by hand: (1) run \`ssh-keygen -t ed25519 -N "" -f <path>\`; ` +
    `(2) \`gh repo deploy-key add <path>.pub -R ${repo} --allow-write --title sapwood-worker-<hostname>\`; ` +
    `(3) write the id \`gh\` returns into <path>.id (mode 0600); (4) re-run "sapwood init" to confirm the ` +
    `preflight — or re-run "sapwood init" from an interactive terminal to be offered this automatically.`;

  let choice: "a" | "b" = "b";
  if (deps.isInteractive()) {
    const answer = await deps.promptOperator(
      `deploy key: ${reasonText}.${staleNote}\n` +
        `(a) register a NEW per-machine deploy key (every existing remote key is left untouched)\n` +
        `(b) skip — proceed at L0 (full credentialed worker env)\n` +
        `Choice [a/b]: `,
    );
    choice = answer.trim().toLowerCase().startsWith("a") ? "a" : "b";
  }

  if (choice === "b") {
    actions.push(
      `deploy key: WARN — ${reasonText}.${staleNote} Proceeding at L0 (full credentialed worker env); every ` +
        `remote key AND every local file is left untouched. ${manualSteps} See <${DOC_LINKS.security}>'s worker ` +
        `credential tiers.`,
    );
    return actions;
  }

  // choice === "a" — a fresh read of the remote sapwood-titled titles, as close to the actual
  // slot pick as practical: an interactive prompt can leave an arbitrary real-world gap since
  // `staleForeignKeys` was gathered, during which another process could have registered a
  // colliding per-host title. Falls back to the (possibly stale) `staleForeignKeys` list on a
  // read failure rather than blocking the whole arm over this one refresh.
  let knownRemoteTitles: ReadonlySet<string>;
  try {
    const fresh = parseDeployKeys(await run(["repo", "deploy-key", "list", "-R", repo, "--json", "id,title"]));
    knownRemoteTitles = new Set(fresh.filter((k) => isSapwoodWorkerTitle(k.title)).map((k) => k.title));
  } catch {
    knownRemoteTitles = new Set(staleForeignKeys.map((k) => k.title));
  }
  const hostComponent = sanitizeHostnameForKeyTitle(deps.hostname());
  // pickFreshArmAKeySlot THROWS on exhaustion (never a synthesized fallback candidate) — folded
  // into the SAME try/catch as keygen/add below so that failure degrades exactly like any other
  // provisioning failure. `fallbackKeyPath`/`fallbackTitle` (the UN-suffixed base candidate) name
  // the WARN's manual steps when slot-picking itself is what failed, since `keyPath`/`title`
  // never get assigned in that case.
  const fallbackKeyPath = join(deployKeysDir(cwd), `${DEPLOY_KEY_BASENAME}-${hostComponent}`);
  const fallbackTitle = `${DEPLOY_KEY_TITLE}-${hostComponent}`;
  let keyPath: string;
  let title: string;
  let newId: number;
  try {
    ({ path: keyPath, title } = pickFreshArmAKeySlot(cwd, hostComponent, knownRemoteTitles));
    actions.push(
      `deploy key: operator chose (a) — registering a NEW per-machine deploy key titled "${title}"; every ` +
        `existing remote key is left untouched.`,
    );
    enforceDeployKeyPermissionsOrThrow(keyPath, permissionsFs); // dir ready (0700) before ssh-keygen writes into it
    await deps.sshKeygen(keyPath);
    enforceDeployKeyPermissionsOrThrow(keyPath, permissionsFs); // repair the freshly-written private key's mode too
    newId = await addDeployKeyCapturingNewId(run, repo, keyPath, title);
  } catch (e) {
    actions.push(deployKeyProvisioningFailedAction(repo, fallbackKeyPath, fallbackTitle, e));
    return actions;
  }
  actions.push(`deploy key: added write deploy key "${title}" to ${repo}`);

  const probe = await deps.probeSshAuth(keyPath);
  if (!probe.ok) {
    actions.push(deployKeyPreflightFailedAction(keyPath, probe.detail));
    return actions;
  }
  actions.push(`deploy key: SSH auth preflight OK for ${keyPath}`);

  try {
    writeDeployKeyIdSidecar(keyPath, newId, permissionsFs);
  } catch (e) {
    actions.push(deployKeyProvisioningFailedAction(repo, keyPath, title, e));
    return actions;
  }
  actions.push(`deploy key: recorded the local anchor at ${keyIdSidecarPath(keyPath)} — L1 active once worker.credentialTier is L1`);

  actions.push(...(await checkDefaultBranchProtectionAction(run, repo)));
  return actions;
}

/** Both a local key file AND its id sidecar discovered (findDeployKeyAnchor) -> RECONCILE, never
 *  skipped: a stale/rotated/mismatched key must be actively detected, not assumed good because a
 *  path is on file. Permission repair is attempted only once every other check already agrees
 *  this anchor is otherwise valid, so a stale id / content mismatch / failed preflight reaches
 *  the auth-fails/stale/mismatch arm (armAuthFailsStaleOrMismatch) having touched nothing on
 *  disk. */
async function reconcileDeployKey(
  run: GhRunner,
  repo: string,
  cwd: string,
  keyPath: string,
  keyId: number,
  deps: Pick<InitDeps, "sshKeygen" | "probeSshAuth" | "isInteractive" | "promptOperator" | "hostname">,
  permissionsFs: DeployKeyPermissionsFsOps = realDeployKeyPermissionsFsOps,
): Promise<string[]> {
  const localFileOk = existsSync(keyPath);
  let listedKeys: DeployKeyListEntry[] = [];
  let matchedEntry: DeployKeyListEntry | undefined;
  try {
    listedKeys = parseDeployKeys(await run(["repo", "deploy-key", "list", "-R", repo, "--json", "id,title,key"]));
    matchedEntry = listedKeys.find((k) => k.id === keyId);
  } catch {
    matchedEntry = undefined;
  }
  const idListed = matchedEntry !== undefined;

  // Cross-check the LOCAL public key file's content against the id-matched remote entry's own
  // `key` field — "the id is registered" alone doesn't prove THIS local file is the key behind
  // it.
  let keyContentMatches = false;
  if (idListed && localFileOk) {
    try {
      const localPub = normalizePublicKey(readFileSync(`${keyPath}.pub`, "utf8"));
      keyContentMatches = matchedEntry?.key !== undefined && localPub === normalizePublicKey(matchedEntry.key);
    } catch {
      keyContentMatches = false;
    }
  }

  const probe = localFileOk ? await deps.probeSshAuth(keyPath) : { ok: false, detail: "local key file missing" };

  // A repair failure here (the anchored path is a directory/symlink, an unwritable mount, or any
  // other chmod/lstat error) is a reported degradation, never silently swallowed into a green
  // "reconciled" verdict below. enforceDeployKeyPermissions itself never throws (every failure
  // comes back as `{ ok: false, reason }`), so this needs no try/catch of its own. Deliberately
  // gated on the other four signals already being green: an anchor that is already headed for
  // the WARN-only arm (stale id, content mismatch, failed preflight) must not have its
  // permissions touched on the way there.
  let permissionRepair: { ok: true } | { ok: false; reason: string } = { ok: true };
  if (localFileOk && idListed && keyContentMatches && probe.ok) {
    permissionRepair = enforceDeployKeyPermissions(keyPath, permissionsFs);
    if (permissionRepair.ok) permissionRepair = enforceDeployKeyPermissions(keyIdSidecarPath(keyPath), permissionsFs);
  }

  if (localFileOk && permissionRepair.ok && idListed && keyContentMatches && probe.ok) {
    const actions = [
      `deploy key: reconciled — ${keyPath} (id ${keyId}) is registered on ${repo} and the SSH auth preflight is ` +
        `green — L1 active once worker.credentialTier is L1`,
    ];
    actions.push(...(await checkDefaultBranchProtectionAction(run, repo)));
    return actions;
  }

  const reasons: string[] = [];
  if (!localFileOk) reasons.push(`local key file missing at ${keyPath}`);
  if (!idListed) reasons.push(`recorded id ${keyId} not found on ${repo}'s registered deploy keys`);
  if (idListed && localFileOk && !keyContentMatches) {
    reasons.push(
      `the local key at ${keyPath} does not match the public key registered under id ${keyId} — the recorded ` +
        `(key, id) pair no longer refers to the same key`,
    );
  }
  if (localFileOk && !probe.ok) reasons.push(`SSH auth preflight failed${probe.detail ? `: ${probe.detail}` : ""}`);
  if (!permissionRepair.ok) reasons.push(`could not repair key permissions: ${permissionRepair.reason}`);
  const staleForeign = listedKeys.filter((k) => isSapwoodWorkerTitle(k.title));
  return armAuthFailsStaleOrMismatch(run, repo, cwd, staleForeign, reasons, deps, permissionsFs);
}

/** Orchestrator: a local anchor discovered (findDeployKeyAnchor) -> reconcile; none discovered,
 *  with no sapwood-titled remote key -> fresh provisioning; none discovered but a sapwood-titled
 *  key already exists remotely -> the auth-fails/stale/mismatch arm, same as a reconcile failure
 *  — a remote title alone can never establish "mine," so an unrecorded sapwood-titled key is
 *  treated as foreign, never adopted by name. Every failure degrades to an L0 guidance-carrying
 *  WARN, never a thrown error — `init()` itself never fails because L1 provisioning didn't
 *  complete; whether that failure actually MATTERS is decided at `sapwood run` time by
 *  `worker.credentialTier` (deploy-key-startup-check.ts), not here. */
export async function ensureDeployKey(
  run: GhRunner,
  repo: string,
  cwd: string,
  deps: Pick<InitDeps, "sshKeygen" | "probeSshAuth" | "isInteractive" | "promptOperator" | "hostname">,
  // #1080: injectable ONLY so tests can deterministically simulate a chmod/lstat failure — see
  // DeployKeyPermissionsFsOps's own doc. Production never passes this; it's not part of
  // InitDeps because init() itself has no reason to ever override it.
  permissionsFs: DeployKeyPermissionsFsOps = realDeployKeyPermissionsFsOps,
): Promise<string[]> {
  const anchor = findDeployKeyAnchor(defaultRuntimeRoot(cwd));
  if (anchor !== undefined) {
    return reconcileDeployKey(run, repo, cwd, anchor.keyPath, anchor.keyId, deps, permissionsFs);
  }

  const keyPath = join(deployKeysDir(cwd), DEPLOY_KEY_BASENAME);
  let existingKeys: DeployKeyListEntry[];
  try {
    existingKeys = parseDeployKeys(await run(["repo", "deploy-key", "list", "-R", repo, "--json", "id,title"]));
  } catch (e) {
    return [deployKeyProvisioningFailedAction(repo, keyPath, DEPLOY_KEY_TITLE, e)];
  }
  const priorSapwoodKeys = existingKeys.filter((k) => isSapwoodWorkerTitle(k.title));
  if (priorSapwoodKeys.length > 0) {
    // Per the owner ruling: a title alone is never authoritative for "mine". Never touch it.
    return armAuthFailsStaleOrMismatch(run, repo, cwd, priorSapwoodKeys, [], deps, permissionsFs);
  }

  // Fresh provisioning: no local anchor, nothing sapwood-titled remotely.
  const actions: string[] = [];
  let newId: number;
  try {
    const privateExists = existsSync(keyPath);
    const pubExists = existsSync(`${keyPath}.pub`);
    if (privateExists !== pubExists) {
      // Exactly one half present — an interrupted previous run, or a stray file left by hand.
      // ssh-keygen would silently overwrite whichever half is missing; refuse instead, same as
      // any other provisioning failure below (WARN, degrade to L0, never touch what's there).
      throw new Error(
        pubExists
          ? `${keyPath}.pub exists but its private half does not — refusing to run ssh-keygen, which would overwrite it`
          : `${keyPath} exists but its public half (.pub) does not — refusing to register it without a matching .pub`,
      );
    }
    if (!privateExists) {
      enforceDeployKeyPermissionsOrThrow(keyPath, permissionsFs); // dir ready (0700) before ssh-keygen writes into it
      await deps.sshKeygen(keyPath);
    }
    enforceDeployKeyPermissionsOrThrow(keyPath, permissionsFs); // repair mode whether just generated or reused
    newId = await addDeployKeyCapturingNewId(run, repo, keyPath, DEPLOY_KEY_TITLE);
  } catch (e) {
    actions.push(deployKeyProvisioningFailedAction(repo, keyPath, DEPLOY_KEY_TITLE, e));
    return actions;
  }
  actions.push(`deploy key: added write deploy key "${DEPLOY_KEY_TITLE}" to ${repo}`);

  const probe = await deps.probeSshAuth(keyPath);
  if (!probe.ok) {
    actions.push(deployKeyPreflightFailedAction(keyPath, probe.detail));
    return actions;
  }
  actions.push(`deploy key: SSH auth preflight OK for ${keyPath}`);

  try {
    writeDeployKeyIdSidecar(keyPath, newId, permissionsFs);
  } catch (e) {
    actions.push(deployKeyProvisioningFailedAction(repo, keyPath, DEPLOY_KEY_TITLE, e));
    return actions;
  }
  actions.push(`deploy key: recorded the local anchor at ${keyIdSidecarPath(keyPath)} — L1 active once worker.credentialTier is L1`);

  actions.push(...(await checkDefaultBranchProtectionAction(run, repo)));
  return actions;
}

// ---- #128: north-star goal file scaffold ----------------------------------------------------

/** Resolves the shipped goal-file template — `engine/prompts/goal-template.md` inside the
 *  engine package, same "next to the shipped prompts" resolution as worker.ts's
 *  defaultPromptPath (`here` is two levels below `engine/` in both `engine/src/loop` (tsx) and
 *  `engine/dist` (built), so this join lands on `engine/prompts` either way). A module constant
 *  would work too, but this repo already ships every other role's starter content as a file
 *  next to worker.md/architect.md/etc — reusing that pattern costs nothing and keeps the
 *  template's prose out of init.ts's diff noise. */
export function defaultGoalTemplatePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "prompts", "goal-template.md");
}

/** cfg.goal.file is config-file-relative resolved by loadConfig (#128) for a REAL run, but a
 *  cfg built directly via parseConfig/ConfigSchema (no file on disk — every init.test.ts case,
 *  and any future direct caller) leaves it exactly as configured, which may still be relative.
 *  Absolute -> used as-is; relative -> resolved against `cwd`, the same directory ensureConfig
 *  above writes the starter config into (the ordinary case: config and goal file share a repo
 *  root). */
export function resolveGoalFilePath(goalFile: string, cwd: string): string {
  return isAbsolute(goalFile) ? goalFile : join(cwd, goalFile);
}

/** Scaffold the north-star goal-file template IFF the resolved path is missing. Never
 *  overwrites an existing file (it's the user's document, not sapwood's) — this IS the
 *  idempotence: a second `sapwood init` run against a repo that already has the file (whether
 *  sapwood wrote it or a human did) is a byte-for-byte no-op. Returns the path written, or null
 *  when the file already existed. */
function ensureGoalFile(cfg: SapwoodConfig, cwd: string): string | null {
  const target = resolveGoalFilePath(cfg.goal.file, cwd);
  if (existsSync(target)) return null;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(defaultGoalTemplatePath(), "utf8"));
  return target;
}

// ---- #167: repo-level review-doctrine file scaffold ------------------------------------------

/** Resolves the shipped doctrine-file template — `engine/prompts/doctrine-template.md` inside
 *  the engine package, same "next to the shipped prompts" resolution as
 *  defaultGoalTemplatePath above (and the same rationale: reuse the existing "ship every role's
 *  starter content as a file next to worker.md/architect.md/goal-template.md" pattern rather
 *  than a module constant). */
export function defaultDoctrineTemplatePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "prompts", "doctrine-template.md");
}

/** cfg.doctrine.file is config-file-relative resolved by loadConfig (#167, same shape as
 *  goal.file/#128) for a REAL run, but a cfg built directly via parseConfig/ConfigSchema (no
 *  file on disk — every init.test.ts case, and any future direct caller) leaves it exactly as
 *  configured, which may still be relative. Absolute -> used as-is; relative -> resolved against
 *  `cwd`, the same directory ensureConfig above writes the starter config into. */
export function resolveDoctrineFilePath(doctrineFile: string, cwd: string): string {
  return isAbsolute(doctrineFile) ? doctrineFile : join(cwd, doctrineFile);
}

/** Scaffold the review-doctrine template IFF the resolved path is missing. Never overwrites an
 *  existing file (it's the user's document once it exists, not sapwood's) — this IS the
 *  idempotence: a second `sapwood init` run against a repo that already has the file (whether
 *  sapwood wrote it or a human did) is a byte-for-byte no-op. Returns the path written, or null
 *  when the file already existed. Same shape as ensureGoalFile above. */
function ensureDoctrineFile(cfg: SapwoodConfig, cwd: string): string | null {
  const target = resolveDoctrineFilePath(cfg.doctrine.file, cwd);
  if (existsSync(target)) return null;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(defaultDoctrineTemplatePath(), "utf8"));
  return target;
}

// ---- #194: GitHub issue-template scaffold -----------------------------------------------

export const ISSUE_TEMPLATE_NAMES = ["feature.md", "fix.md", "docs.md", "chore.md"] as const;
export type IssueTemplateName = (typeof ISSUE_TEMPLATE_NAMES)[number];

/** Resolve one of the four issue templates shipped inside the engine package. */
export function defaultIssueTemplatePath(name: IssueTemplateName): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "prompts", "issue-templates", name);
}

/** Write each missing issue template into the target repo, preserving every existing file. */
function ensureIssueTemplates(cwd: string): Array<{ path: string; written: boolean }> {
  const targetDir = join(cwd, ".github", "ISSUE_TEMPLATE");
  return ISSUE_TEMPLATE_NAMES.map((name) => {
    const target = join(targetDir, name);
    if (existsSync(target)) return { path: target, written: false };
    mkdirSync(targetDir, { recursive: true });
    try {
      writeFileSync(target, readFileSync(defaultIssueTemplatePath(name), "utf8"), { flag: "wx" });
      return { path: target, written: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { path: target, written: false };
      throw error;
    }
  });
}

// ---- orchestrator ---------------------------------------------------------------

export interface InitResult {
  actions: string[];
}

/** Run the full init flow. Idempotent: a second run reports zero create actions. */
export async function init(cfg: SapwoodConfig, deps: Partial<InitDeps> = {}): Promise<InitResult> {
  const { run, getAuthStatus, cwd, sshKeygen, probeSshAuth, isInteractive, promptOperator, hostname } = { ...defaultDeps(), ...deps };
  // #187: fileRaw is a loadConfig-only, non-schema annotation; validate a schema-owned copy.
  const { fileRaw: _fileRaw, ...doctrineSchemaFields } = cfg.doctrine;
  ConfigSchema.parse({ ...cfg, doctrine: doctrineSchemaFields });
  const repo = `${cfg.board.owner}/${cfg.board.repo}`;
  const actions: string[] = [];

  // The runtime root must exist before the deploy key can be provisioned under its `keys/`
  // subdirectory below — created via the SAME `ensureRuntimeRoot` every other state-touching
  // command uses, so init's root and the engine's own root can never drift apart. No tree-level
  // "foreign directory" heuristic: init is idempotent by contract (a second run must report zero
  // create actions) and never creates the DB itself, so a heuristic trying to detect "this isn't
  // sapwood's own directory" would refuse init's own second run. The ONLY refusal is `.sapwood`
  // already existing as something other than a directory — checked here (not left to
  // `ensureRuntimeRoot`'s own `mkdir`) so the message names `sapwood init` itself rather than an
  // unqualified filesystem error. Every other collision (an existing directory carrying unrelated
  // content) is handled per owned file, same as init's other scaffolded files below.
  const runtimeRoot = defaultRuntimeRoot(cwd);
  if (existsSync(runtimeRoot) && !statSync(runtimeRoot).isDirectory()) {
    throw new InitError(`${runtimeRoot} already exists and is not a directory — remove or rename it, then re-run "sapwood init".`);
  }
  ensureRuntimeRoot(runtimeRoot, (message) => actions.push(message));
  actions.push(`runtime root: ${runtimeRoot}`);

  await preflight(getAuthStatus);

  const ownerKind = cfg.board.ownerKind ?? (await detectOwnerKind(cfg.board.owner, run));
  actions.push(`owner ${cfg.board.owner} is a ${ownerKind}`);

  const newLabels = await ensureLabels(cfg, run, repo);
  actions.push(newLabels.length ? `created ${newLabels.length} label(s): ${newLabels.join(", ")}` : "labels already present");

  // #397 item 6: REPORT description drift, never rewrite it. The no-`--force` default protects a
  // user's own customization and stays; the failure it hides is that our own repo silently kept
  // pre-#248 label text for months, so the drift now has to say itself out loud. Reported AFTER
  // creation so a label this run just created (with the shipped text) can never read as drifted.
  for (const drift of await describeLabelDrift(run, repo, requiredLabels(cfg))) {
    actions.push(`label description drift (not modified): ${drift}`);
  }

  const newMs = await ensureMilestones(cfg, run, repo);
  if (cfg.milestones.length) {
    actions.push(newMs.length ? `created milestone(s): ${newMs.join(", ")}` : "milestones already present");
  }

  actions.push(...(await ensureBoard(cfg, ownerKind, run)));

  const written = ensureConfig(cwd);
  actions.push(written ? `wrote starter config ${written}` : "config already present");

  // #801: the shipped scaffold (sapwood.config.example.yaml, or the inline fallback below when
  // that file is missing from the package) deliberately pins reviewer.mode: engine-agent (#501)
  // but ships NO ci.requiredChecks — there is no real CI check name init could safely guess for
  // an arbitrary target repository, and writing a plausible-looking WRONG one (e.g. "test") would
  // silently reintroduce the exact queue-forever foot-gun #784 exists to catch, just one layer
  // deeper (the startup check would pass, but the CI-evidence preflight would never find a
  // matching CheckRun). So the scaffold stays honest and empty; instead, `sapwood run`'s own
  // future refusal (#784) is surfaced HERE, at init time, so the operator is told BEFORE they
  // ever hit it rather than discovering it only when `run` (or `validate`, #801) cliffs. `cfg` is
  // whatever this run is actually acting on — the just-written starter's own effective defaults
  // on fresh onboarding, or an already-customized file's real values on a re-run — so this never
  // fires once the operator has configured ci.requiredChecks (or picked a non-engine-agent mode).
  const ciConfigError = engineAgentEmptyCiRequiredChecksError(cfg);
  if (ciConfigError) {
    actions.push(
      `config: WARN — ${ciConfigError} Configure this before your first \`sapwood run\` — see ` +
        `<${DOC_LINKS.gettingStarted}>'s "Before your first run: make gate① real" section.`,
    );
  }

  // L1 scoped-worker-identity deploy key — provisioned AFTER the config file exists (ensureConfig
  // above), so a fresh onboarding's repo/board facts are already resolved. Every failure degrades
  // to a guidance-carrying WARN; init() itself never fails because L1 provisioning didn't
  // complete (`worker.credentialTier` governs whether that actually matters at `sapwood run` time
  // — deploy-key-startup-check.ts, not here). This never touches sapwood.config.yaml — the anchor
  // lands under `.sapwood/keys/` instead.
  actions.push(
    ...(await ensureDeployKey(run, repo, cwd, {
      sshKeygen,
      probeSshAuth,
      isInteractive,
      promptOperator,
      hostname,
    })),
  );

  // #128: the north-star goal file — scaffolded iff missing, never overwriting a user's doc.
  const goalWritten = ensureGoalFile(cfg, cwd);
  actions.push(
    goalWritten ? `wrote starter goal file ${goalWritten}` : `goal file already present (${resolveGoalFilePath(cfg.goal.file, cwd)})`,
  );

  // #167: the repo-level review-doctrine file — scaffolded iff missing, never overwriting a
  // user's doc. Same idempotence contract as the goal file above.
  const doctrineWritten = ensureDoctrineFile(cfg, cwd);
  actions.push(
    doctrineWritten
      ? `wrote starter doctrine file ${doctrineWritten}`
      : `doctrine file already present (${resolveDoctrineFilePath(cfg.doctrine.file, cwd)})`,
  );

  for (const template of ensureIssueTemplates(cwd)) {
    actions.push(template.written ? `wrote issue template ${template.path}` : `issue template already present (${template.path})`);
  }

  actions.push(
    "guard hook: built and wired live into every worker session at dispatch time (by worker.ts, not by init) — " +
      "guard.ts, hook wiring and security config stay human-merge-only",
  );
  return { actions };
}

async function detectOwnerKind(owner: string, run: GhRunner): Promise<OwnerKind> {
  const out = await run(["api", `users/${owner}`, "--jq", ".type"]);
  return out.trim() === "Organization" ? "org" : "user";
}
