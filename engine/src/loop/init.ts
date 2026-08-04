// `sapwood init` — credible, idempotent, recovery-safe onboarding. Automates the manual
// GitHub setup 0day left to the human (bootstrap_github.sh:89 just says "make the board
// by hand"). Detect-before-create everywhere, so re-running is always safe.
//
// Steps: auth preflight -> user-vs-org -> ensure labels -> ensure milestones ->
// ensure ProjectV2 board (Status lanes) -> write starter config.
// The guard PreToolUse hook is built (guard.ts / guard-hook.ts) and wired live per session by
// worker.ts at dispatch time, not by init — init only reports that, and that guard.ts/hook
// wiring/security config are human-merge-only per CLAUDE.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ConfigSchema, DEFAULT_CONFIG_PATHS, parseConfig, type SapwoodConfig } from "../config/config.js";
import type { OwnerKind } from "../forge/forge.js";
import { type GhRunner, gh, ghText } from "../forge/gh.js";
import { createMissingLabels, describeLabelDrift, type LabelSpec, normalizeLabel, taxonomyLabels } from "../forge/labels.js";
import { type LlmPingResult, probeDeployKeySsh, spawnSshKeygen } from "../roles/worker.js";

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
    { name: l.inProgress, color: "0e8a16", description: "Claimed by a worker (in flight)" },
    // #397: every escalation-tier description answers the same three questions a human staring at
    // the label needs — WHO writes it / WHAT the human must do / WHAT removing it does — inside
    // GitHub's 100-char description limit, and identical to the row in docs/configuration.md
    // (init.test.ts pairs them, the same check #400 introduced for `hold`).
    { name: l.needsHuman, color: "5319e7", description: "Engine-applied: autonomy stopped, a human decides; remove to hand it back." },
    { name: l.blocked, color: "5319e7", description: "Engine- or human-applied: an external wait; remove once it clears." },
    { name: l.reserve, color: "5319e7", description: "Human-applied: parked out of dispatch; remove to make it dispatchable again." },
    { name: l.verifyNa, color: "c5def5", description: "Verification N/A — skips the Decision #8 gate" },
    { name: l.planApproved, color: "0e8a16", description: "Verification plan approved by gate zero" },
    { name: l.originAgent, color: "bfd4f2", description: "Issue was created by an agent, not a human" },
    { name: l.split, color: "fbca04", description: "Human request to decompose this issue once" },
    { name: l.decomposed, color: "6e7781", description: "Parent retired as a decomposition tracking container" },
    // #212: round-pool membership — applied by the aligning phase's pool-selection pass,
    // cleared by the engine at round close (never by a session — see removeRoundPoolLabel).
    { name: l.roundPool, color: "5319e7", description: "In this round's dispatch-eligible pool" },
    // #397 bucket 2 — the ONE meaning `needs-human` could never express: not "the machine is
    // stuck", but "this PR's merge decision belongs to a human." Written once, on the PR, and
    // never re-evaluated, so the description says the loop will not take it back.
    {
      name: l.humanMergeOnly,
      color: "b60205",
      description: "Engine-applied on the PR: a human must merge it. The loop never removes or re-decides this.",
    },
    // #399: the PR-side lane-state mirror. The description answers the same three questions every
    // escalation-tier description does — WHO writes it / WHAT it means / WHAT removal does — and
    // the answer to the third is "nothing you need to do": the engine removes it itself when the
    // lane ends. Identical to the row in docs/configuration.md (the #397/#400 pairing check).
    {
      name: l.laneState,
      color: "0e8a16",
      description: "Engine-applied on the PR: a lane is actively working it. Removed automatically when the lane ends.",
    },
    // #397 class 6 — explicitly NOT an escalation, so the description says so: nobody is on the
    // hook, it just keeps a plan-less issue off every queue until a plan exists.
    {
      name: l.planless,
      color: "6e7781",
      description: "Engine-applied: no verification plan — off every queue. Not an escalation; add one, then remove.",
    },
  ];
  // #248 review round 1 (G2): the shipped `escalation.holdLabels` default (sapwood:hold) is
  // otherwise unusable on a clean repo — nothing ever creates the GitHub label itself, so a
  // human trying to apply it from the PR UI finds no such label to pick. Provisioning the REPO
  // label here is not "writing a hold" (write-side asymmetry, #248's own doctrine, is about the
  // engine applying a hold TO an issue/PR — creating the label definition itself is the same
  // one-time repo-setup act `sapwood init` already does for needsHuman/blocked/etc above).
  // Deduplicated case-insensitively against `base` (and against itself) — a `holdLabels` entry
  // that happens to equal a taxonomy label name (config load's own collision guard only checks
  // it against OTHER protected labels/humanLabels, not the fixed type:*/prio:* taxonomy) must
  // not produce two LabelSpec rows with the same name and different color/description.
  const haveNames = new Set(base.map((spec) => normalizeLabel(spec.name)));
  const holdSpecs: LabelSpec[] = [];
  for (const name of cfg.escalation.holdLabels) {
    const key = normalizeLabel(name);
    if (haveNames.has(key)) continue;
    haveNames.add(key);
    // #400: the description carries the whole contract — purpose, carrier, what removal does, and
    // that an issue is NOT a carrier. Kept identical in docs/configuration.md (init.test.ts pairs
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

// ---- ProjectV2 board (the step 0day left manual) --------------------------------

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
  // Ship the committed commented sample (repo root) with the package.
  const here = dirname(fileURLToPath(import.meta.url));
  const sample = join(here, "..", "..", "..", "sapwood.config.yaml");
  if (existsSync(sample)) return readFileSync(sample, "utf8");
  return "board:\n  owner: CHANGEME\n  repo: CHANGEME\n  projectNumber: 0\n";
}

/** The config file `sapwood init` is actually acting on THIS run — the one `ensureConfig` just
 *  wrote (fresh onboarding), or whichever of DEFAULT_CONFIG_PATHS already existed (every re-run).
 *  Null only when neither holds, which should be unreachable right after ensureConfig runs. */
function resolveActiveConfigPath(cwd: string, justWritten: string | null): string | null {
  if (justWritten) return justWritten;
  return DEFAULT_CONFIG_PATHS.map((c) => join(cwd, c)).find(existsSync) ?? null;
}

// ---- #606 gate② round 1 (#351 final ruling; OWNER RULING supersedes the title-only design):
// L1 scoped-worker-identity deploy-key provisioning, anchored on the LOCAL (deployKeyPath,
// deployKeyId) pair — NEVER on the bare remote title, which may validly belong to a different
// machine/operator and is never engine-deleted. ------------------------------------------------

const DEPLOY_KEY_TITLE = "sapwood-worker";

export interface DeployKeyListEntry {
  id: number;
  title: string;
}

/** #606 gate② round 1 (P1-1): `gh repo deploy-key list --json id,title` — REQUIRES `--json`
 *  first (confirmed by a live probe on this repo: `--jq` without it fails "cannot use --jq
 *  without specifying --json"). This is DIFFERENT from `gh api ...--jq`'s own idiom (this file's
 *  ensureMilestones/checkDefaultBranchProtectionAction both use `gh api --jq` with no `--json` —
 *  legal there because `gh api`'s whole HTTP response already IS the JSON payload being
 *  filtered; `gh repo deploy-key list` is a table-output "list" command whose `--jq` needs an
 *  explicit `--json <fields>` selection first). Parses `id` alongside `title` now — the owner
 *  ruling's local (path, id) anchor needs ids to reconcile against, which the superseded
 *  title-only `--jq '.[].title'` parse could never supply. */
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
    if (typeof id === "number" && typeof title === "string") out.push({ id, title });
  }
  return out;
}

/** #606 gate② round 1: true for the base title OR any per-machine title the auth-fails/stale/
 *  mismatch arm's choice (a) mints (`sapwood-worker-<hostname>`) — used ONLY to detect "is there
 *  ANY sapwood-provisioned deploy key already on this repo" so fresh provisioning doesn't
 *  register a colliding second base-titled key. This is explicitly NOT an ownership check —
 *  ownership is decided by the LOCAL (path, id) anchor alone, per the owner ruling (a title is
 *  never authoritative for "mine"). */
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

/** #606 gate② round 1 guidance-carrying WARN (#554 pattern): fired whenever ssh-keygen/`gh repo
 *  deploy-key add` fails for ANY reason — no repo-admin scope is the expected cause, but this
 *  deliberately doesn't try to classify the gh error text to confirm that specifically (doctrine:
 *  gh's own exit failure is already an authoritative signal that provisioning didn't happen;
 *  guessing WHY from free text would be the inferred-text case this repo's doctrine treats as a
 *  last resort, not a first one). Names the exact manual steps + a docs anchor; the engine stays
 *  fully functional at L0 either way — never a startup failure. */
function deployKeyProvisioningFailedAction(repo: string, keyPath: string, title: string, e: unknown): string {
  const reason = (e instanceof Error ? e.message : String(e)).split("\n")[0]?.trim() || "unknown error";
  return (
    `deploy key: WARN — could not provision a write deploy key for ${repo} (${reason}). This usually means the ` +
    `operator's gh token lacks repo admin. Engine stays fully functional at L0 (today's full credentialed ` +
    `worker env) — no action required. To enable L1 by hand: (1) run ` +
    `\`ssh-keygen -t ed25519 -N "" -f ${keyPath}\`; (2) in the repo's Settings -> Deploy keys, add ` +
    `${keyPath}.pub with write access allowed, title "${title}"; (3) set worker.deployKeyPath/` +
    `worker.deployKeyId in your config (the id shown in that Settings page's key list); (4) re-run ` +
    `"sapwood init" to confirm the preflight. See docs/security.md's worker credential tiers.`
  );
}

/** #606 gate② round 1 guidance-carrying WARN: the preflight-fail arm — the key IS registered (or
 *  was just added) but SSH auth against it didn't succeed (host-key/network/local key-material
 *  issue). Same "never wedge, name the fix" contract as every other #554-pattern WARN here. */
function deployKeyPreflightFailedAction(keyPath: string, detail: string | undefined): string {
  return (
    `deploy key: WARN — SSH auth preflight failed for ${keyPath}${detail ? `: ${detail}` : ""}. Engine stays at ` +
    `L0 (full credentialed worker env) until this passes. Fix: confirm ${keyPath} is a readable private key ` +
    `matching the deploy key registered on the repo, then re-run "sapwood init" to re-check the preflight. ` +
    `See docs/security.md's worker credential tiers.`
  );
}

const WORKER_BLOCK_LINE = /^worker:\s*(#.*)?$/;
const WORKER_FLOW_LINE = /^worker:\s*\{/;
// `m` (multiline) so `^` matches the start of EVERY line, not just the start of the whole file —
// both regexes are also used per-line (a single-line string, where `m` changes nothing), but
// clearDeployKeyConfigFromYaml's own no-op check tests them against the FULL multi-line file
// text, where a missing `m` flag would only ever match a deployKeyPath:/deployKeyId: line that
// happens to sit at byte offset 0 of the file — silently false-no-op every ordinary case.
const DEPLOY_KEY_PATH_LINE = /^[ \t]*deployKeyPath:/m;
const DEPLOY_KEY_ID_LINE = /^[ \t]*deployKeyId:/m;

/** #606 gate② round 1 (P1-2/P2-8): writes BOTH `worker.deployKeyPath` and `worker.deployKeyId` —
 *  the local (path, id) anchor pair the owner ruling's reconcile/idempotence logic keys on, never
 *  the bare title. Surgical text edit, NOT a parse->stringify round trip — this repo's own config
 *  is hand-edited, heavily commented YAML (CLAUDE.md's locked decision), and a full re-serialize
 *  would destroy every comment in it.
 *
 *  P2-8 hardening (gate② round 1 findings): (i) a top-level `worker:` line MAY carry a trailing
 *  comment (`worker: # a note`) — matched now (WORKER_BLOCK_LINE), not just the bare `worker:`
 *  the superseded version required exactly. (ii) a FLOW-style `worker: { ... }` mapping is never
 *  edited — inserting a block-style child under it risks invalid YAML this function cannot
 *  verify by regex alone, so it returns a hand-edit WARN instead of guessing. (iii) after
 *  writing, the file is RE-READ and re-parsed with parseConfig(); if that fails, or the keys
 *  didn't actually land as written, the ORIGINAL bytes are restored and a hand-edit WARN is
 *  returned — an honest fallback, never a corrupted config file left behind. Any prior
 *  `deployKeyPath:`/`deployKeyId:` lines (however indented) are stripped first, so this is also
 *  the "replace" path for a fresh key superseding a cleared stale one — never a stale second
 *  copy alongside the new one. */
export function writeDeployKeyConfigIntoYaml(configFilePath: string, relativeKeyPath: string, keyId: number): string[] {
  const original = readFileSync(configFilePath, "utf8");
  if (original.split("\n").some((l) => WORKER_FLOW_LINE.test(l))) {
    return [
      `deploy key: worker.deployKeyPath/worker.deployKeyId NOT written — ${configFilePath} uses a flow-style ` +
        `"worker: { ... }" mapping this tool won't safely edit; add "deployKeyPath: ${relativeKeyPath}" and ` +
        `"deployKeyId: ${keyId}" inside it by hand.`,
    ];
  }
  const comment = "# #606 gate② round 1: L1 write deploy key (path, id) — the local anchor; git transport only, no forge API credential";
  const withoutOldKeys = original.split("\n").filter((l) => !DEPLOY_KEY_PATH_LINE.test(l) && !DEPLOY_KEY_ID_LINE.test(l));
  const newLines = [`  deployKeyPath: ${relativeKeyPath} ${comment}`, `  deployKeyId: ${keyId}`];
  const workerLineIdx = withoutOldKeys.findIndex((l) => WORKER_BLOCK_LINE.test(l));
  let edited: string;
  if (workerLineIdx === -1) {
    const trimmed = withoutOldKeys.join("\n").replace(/\n+$/, "");
    edited = `${trimmed}\n\nworker:\n${newLines.join("\n")}\n`;
  } else {
    const out = [...withoutOldKeys];
    out.splice(workerLineIdx + 1, 0, ...newLines);
    edited = out.join("\n");
  }
  writeFileSync(configFilePath, edited);
  try {
    const reparsed = parseConfig(readFileSync(configFilePath, "utf8"));
    if (reparsed.worker.deployKeyPath !== relativeKeyPath || reparsed.worker.deployKeyId !== keyId) {
      throw new Error("deployKeyPath/deployKeyId did not land as written");
    }
  } catch {
    writeFileSync(configFilePath, original);
    return [
      `deploy key: worker.deployKeyPath/worker.deployKeyId NOT written — an automated edit of ${configFilePath} ` +
        `did not parse back cleanly, so the ORIGINAL file was restored untouched. Add "deployKeyPath: ` +
        `${relativeKeyPath}" and "deployKeyId: ${keyId}" under worker: by hand.`,
    ];
  }
  return [`deploy key: wrote worker.deployKeyPath/worker.deployKeyId into ${configFilePath} — L1 active on the next engine start`];
}

/** #606 gate② round 1 (owner ruling): removes `worker.deployKeyPath`/`worker.deployKeyId` from
 *  the config file. Called BEFORE either sub-choice of the auth-fails/stale/mismatch arm — a
 *  reconcile failure proves the recorded anchor is stale/wrong, and the ruling requires clearing
 *  it in BOTH outcomes: choice (a) replaces it with a freshly-provisioned pair; choice (b) leaves
 *  the config with NO anchor at all, so the NEXT `sapwood init` run takes the fresh-provisioning
 *  path instead of re-reconciling the same broken values forever (this is what makes "re-run
 *  sapwood init" an honest instruction — P1-5). A no-op (returns no actions) when the file
 *  already carries neither key. Same P2-8 flow-style-refusal + read-back-and-restore safety net
 *  as writeDeployKeyConfigIntoYaml. */
export function clearDeployKeyConfigFromYaml(configFilePath: string): string[] {
  const original = readFileSync(configFilePath, "utf8");
  if (!DEPLOY_KEY_PATH_LINE.test(original) && !DEPLOY_KEY_ID_LINE.test(original)) return [];
  const lines = original.split("\n");
  if (lines.some((l) => WORKER_FLOW_LINE.test(l))) {
    return [
      `deploy key: worker.deployKeyPath/worker.deployKeyId NOT cleared — ${configFilePath} uses a flow-style ` +
        `"worker: { ... }" mapping this tool won't safely edit; remove deployKeyPath/deployKeyId from it by hand.`,
    ];
  }
  const withoutKeys = lines.filter((l) => !DEPLOY_KEY_PATH_LINE.test(l) && !DEPLOY_KEY_ID_LINE.test(l));
  // If deployKeyPath/deployKeyId were the ONLY children under worker:, stripping them leaves a
  // bare `worker:` with an implicit YAML null value — which FAILS z.object()'s validation
  // (`.default({})` only substitutes for an ABSENT/undefined key, never an explicit null) and
  // would always trip the read-back check below. Prune the now-empty `worker:` line itself in
  // that case, so the key is genuinely ABSENT (parses as undefined -> the schema default).
  const workerLineIdx = withoutKeys.findIndex((l) => WORKER_BLOCK_LINE.test(l));
  const hasChild = workerLineIdx !== -1 && /^[ \t]+\S/.test(withoutKeys[workerLineIdx + 1] ?? "");
  const edited = (workerLineIdx !== -1 && !hasChild ? withoutKeys.filter((_, i) => i !== workerLineIdx) : withoutKeys).join("\n");
  writeFileSync(configFilePath, edited);
  try {
    const reparsed = parseConfig(readFileSync(configFilePath, "utf8"));
    if (reparsed.worker.deployKeyPath !== undefined || reparsed.worker.deployKeyId !== undefined) {
      throw new Error("deployKeyPath/deployKeyId still present after clearing");
    }
  } catch {
    writeFileSync(configFilePath, original);
    return [
      `deploy key: worker.deployKeyPath/worker.deployKeyId NOT cleared — an automated edit of ${configFilePath} ` +
        `did not parse back cleanly, so the ORIGINAL file was restored untouched. Remove deployKeyPath/` +
        `deployKeyId under worker: by hand.`,
    ];
  }
  return [`deploy key: cleared the stale worker.deployKeyPath/worker.deployKeyId anchor from ${configFilePath}`];
}

/** #606 gate② round 1 (P1-6): private key material must never land inside a `git add -A` sweep.
 *  Checks the repo's `.gitignore` (created if missing) for a line covering the key's location —
 *  an exact match on the key's own repo-relative path, or a `data/` (or `data`) prefix rule (the
 *  location every provisioning/reconcile path in this file uses) — and appends a `data/` rule
 *  with an explanatory comment when neither is present. Best-effort: a failure here is a WARN,
 *  never a reason to fail init — the key was already provisioned; leaving it uncovered is a real
 *  risk but not a reason to abort an otherwise-successful run. */
function ensureGitignoreCoversDeployKeyAction(cwd: string, keyPath: string): string[] {
  const gitignorePath = join(cwd, ".gitignore");
  const relKeyPath = relative(cwd, keyPath).split(sep).join("/");
  try {
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    const covered = existing
      .split("\n")
      .map((l) => l.trim())
      .some((l) => {
        if (!l || l.startsWith("#")) return false;
        const pattern = l.replace(/\/$/, "");
        return pattern === "data" || pattern === relKeyPath || relKeyPath === pattern || relKeyPath.startsWith(`${pattern}/`);
      });
    if (covered) return [];
    const addition = "# sapwood: engine state + worker deploy key — never commit\ndata/\n";
    const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
    writeFileSync(gitignorePath, `${existing}${needsLeadingNewline ? "\n" : ""}${addition}`);
    return [`deploy key: added "data/" to ${gitignorePath} — the private key must never be committed`];
  } catch (e) {
    return [
      `deploy key: WARN — could not update ${gitignorePath} to ignore the private key at ${relKeyPath} (${
        e instanceof Error ? e.message : String(e)
      }). Add a "data/" line to .gitignore by hand — the private key must never be committed.`,
    ];
  }
}

/** #606 gate② round 1 (P2-7): distinguishes protected / confirmed-unprotected / cannot-verify —
 *  the fix-carrying WARN below only fires for a CONFIRMED-unprotected repo (gh's own 404 "Branch
 *  not protected" response); anything else (403/plan-limit/network/an unclassifiable error) gets
 *  a DISTINCT cannot-verify WARN rather than being read as "confirmed unprotected". Parses the
 *  gh error text MINIMALLY (does a 3-digit HTTP status code appear at all) — no deeper
 *  classification, per this file's doctrine of trusting gh's own authoritative signal over
 *  inferred text. */
async function checkDefaultBranchProtectionAction(run: GhRunner, repo: string): Promise<string[]> {
  let branch: string;
  try {
    branch = (await run(["api", `repos/${repo}`, "--jq", ".default_branch"])).trim();
    if (!branch) return [];
  } catch {
    return [];
  }
  try {
    await run(["api", `repos/${repo}/branches/${branch}/protection`]);
    return [`deploy key: default branch "${branch}" on ${repo} is protected`];
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).split("\n")[0]?.trim() || "unknown error";
    const status = message.match(/\b(\d{3})\b/)?.[1];
    if (status === "404") {
      return [
        `deploy key: WARN — default branch "${branch}" on ${repo} has NO branch protection rule. An L1 deploy ` +
          `key can push directly to it (a stolen key's capability equals the granted capability — git push to ` +
          `this repo — but branch protection is still the backstop against the WORKER itself pushing straight ` +
          `to ${branch}). Fix: add a branch protection rule for "${branch}" (repo Settings -> Branches) requiring ` +
          `the merge gate this engine already drives PRs through.`,
      ];
    }
    return [
      `deploy key: WARN — cannot verify branch protection for "${branch}" on ${repo} (${message}). If this repo's ` +
        `plan cannot expose branch-protection status via the API, treat the default branch as UNPROTECTED and add ` +
        `a protection rule for "${branch}" (repo Settings -> Branches) requiring the merge gate this engine ` +
        `already drives PRs through.`,
    ];
  }
}

/** #606 gate② round 1 (OWNER RULING — supersedes the previous title-only-idempotence amendment):
 *  the reconcile failure / no-recorded-anchor state. NEVER deletes or modifies any remote key
 *  (`gh repo deploy-key delete` never appears here, including in guidance text) — the remote
 *  inventory is never authoritative for "mine"; a `sapwood-worker`-titled key may validly belong
 *  to a different machine/operator, so this machine can only ever ADD a new key of its own, never
 *  remove someone else's. Any prior local (deployKeyPath, deployKeyId) anchor is cleared FIRST
 *  (clearDeployKeyConfigFromYaml) in both sub-choices, so a later `sapwood init` re-run never
 *  keeps reconciling against a value already proven stale — the WARN's "re-run sapwood init"
 *  advice actually converges (P1-5).
 *
 *  WARN + operator choice when `deps.isInteractive()`:
 *  (a) leave remote untouched; clear local key config; generate a FRESH keypair; register it as
 *      an ADDITIONAL deploy key titled `sapwood-worker-<hostname>` (collision-free per machine);
 *      record the new (path, id); preflight; write config.
 *  (b) leave remote untouched; clear local config; proceed degraded at L0.
 *  No TTY -> default (b), the no-write, never-wedge path — the WARN still names (a)'s manual
 *  steps. Stale foreign keys are named in the WARN for HUMAN cleanup, never engine-deleted. */
async function armAuthFailsStaleOrMismatch(
  run: GhRunner,
  repo: string,
  cwd: string,
  configFilePath: string | null,
  staleForeignKeys: DeployKeyListEntry[],
  reasons: string[],
  deps: Pick<InitDeps, "sshKeygen" | "probeSshAuth" | "isInteractive" | "promptOperator" | "hostname">,
): Promise<string[]> {
  const actions: string[] = [];
  if (configFilePath !== null && !configFilePath.endsWith(".json")) {
    actions.push(...clearDeployKeyConfigFromYaml(configFilePath));
  }

  const reasonText = reasons.length > 0 ? reasons.join("; ") : "no local (path, id) anchor recorded for this machine";
  const staleNote =
    staleForeignKeys.length > 0
      ? ` Existing sapwood-titled key(s) already on ${repo} (left untouched — never engine-deleted; verify/clean up ` +
        `by hand if any are stale): ${staleForeignKeys.map((k) => `"${k.title}" (id ${k.id})`).join(", ")}.`
      : "";
  const manualSteps =
    `To register an additional per-machine key by hand: (1) run \`ssh-keygen -t ed25519 -N "" -f <path>\`; ` +
    `(2) \`gh repo deploy-key add <path>.pub -R ${repo} --allow-write --title sapwood-worker-<hostname>\`; ` +
    `(3) set worker.deployKeyPath/worker.deployKeyId in your config; (4) re-run "sapwood init" to confirm the ` +
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
        `remote key is left untouched. ${manualSteps} See docs/security.md's worker credential tiers.`,
    );
    return actions;
  }

  // choice === "a"
  const hostComponent = sanitizeHostnameForKeyTitle(deps.hostname());
  const title = `${DEPLOY_KEY_TITLE}-${hostComponent}`;
  const keyPath = join(cwd, "data", `worker-deploy-key-${hostComponent}`);
  actions.push(
    `deploy key: operator chose (a) — registering a NEW per-machine deploy key titled "${title}"; every existing ` +
      `remote key is left untouched (never engine-deleted).`,
  );
  try {
    if (!existsSync(keyPath)) {
      mkdirSync(dirname(keyPath), { recursive: true });
      await deps.sshKeygen(keyPath);
    }
    actions.push(...ensureGitignoreCoversDeployKeyAction(cwd, keyPath));
    await run(["repo", "deploy-key", "add", `${keyPath}.pub`, "-R", repo, "--allow-write", "--title", title]);
  } catch (e) {
    actions.push(deployKeyProvisioningFailedAction(repo, keyPath, title, e));
    return actions;
  }
  actions.push(`deploy key: added write deploy key "${title}" to ${repo}`);

  let newId: number | undefined;
  try {
    const listed = parseDeployKeys(await run(["repo", "deploy-key", "list", "-R", repo, "--json", "id,title"]));
    // Match by title AND public-key content when available; title match alone is acceptable for
    // the key just added above (this call's own add is the only thing that could have just
    // created a NEW entry with this exact per-machine title).
    newId = listed.find((k) => k.title === title)?.id;
  } catch {
    /* fall through to the "id unresolved" WARN below */
  }
  if (newId === undefined) {
    actions.push(
      `deploy key: WARN — registered "${title}" on ${repo} but could not read back its id from ` +
        `\`gh repo deploy-key list\`; worker.deployKeyId was NOT written. Find the id in the repo's Settings -> ` +
        `Deploy keys page and set worker.deployKeyId by hand, alongside worker.deployKeyPath: ${keyPath}.`,
    );
    return actions;
  }

  const probe = await deps.probeSshAuth(keyPath);
  if (!probe.ok) {
    actions.push(deployKeyPreflightFailedAction(keyPath, probe.detail));
    return actions;
  }
  actions.push(`deploy key: SSH auth preflight OK for ${keyPath}`);

  if (configFilePath === null) {
    actions.push("deploy key: WARN — no config file found to write worker.deployKeyPath/worker.deployKeyId into; set them by hand.");
  } else if (configFilePath.endsWith(".json")) {
    actions.push(
      `deploy key: worker.deployKeyPath/worker.deployKeyId NOT written — ${configFilePath} is JSON, not YAML; add ` +
        `"worker": { "deployKeyPath": "${relative(dirname(configFilePath), keyPath)}", "deployKeyId": ${newId} } by hand.`,
    );
  } else {
    actions.push(...writeDeployKeyConfigIntoYaml(configFilePath, relative(dirname(configFilePath), keyPath), newId));
  }

  actions.push(...(await checkDefaultBranchProtectionAction(run, repo)));
  return actions;
}

/** #606 gate② round 1 (OWNER RULING): both `worker.deployKeyPath` AND `worker.deployKeyId`
 *  configured — RECONCILE (never skip, unlike the superseded version, which returned immediately
 *  once `deployKeyPath` was set and so could never actually detect or recover from a stale/
 *  rotated/mismatched key — P1-5). Three checks, ALL must be green: the local key file exists;
 *  the recorded id is present in `gh repo deploy-key list --json id,title`; the SSH preflight
 *  succeeds. All green -> a positive confirmation action line (+ branch-protection check). Any
 *  failure -> the auth-fails/stale/mismatch arm (armAuthFailsStaleOrMismatch). */
async function reconcileDeployKey(
  run: GhRunner,
  repo: string,
  cwd: string,
  configFilePath: string | null,
  deployKeyPath: string,
  deployKeyId: number,
  deps: Pick<InitDeps, "sshKeygen" | "probeSshAuth" | "isInteractive" | "promptOperator" | "hostname">,
): Promise<string[]> {
  const localFileOk = existsSync(deployKeyPath);
  let listedKeys: DeployKeyListEntry[] = [];
  let idListed = false;
  try {
    listedKeys = parseDeployKeys(await run(["repo", "deploy-key", "list", "-R", repo, "--json", "id,title"]));
    idListed = listedKeys.some((k) => k.id === deployKeyId);
  } catch {
    idListed = false;
  }
  const probe = localFileOk ? await deps.probeSshAuth(deployKeyPath) : { ok: false, detail: "local key file missing" };

  if (localFileOk && idListed && probe.ok) {
    const actions = [
      `deploy key: reconciled — ${deployKeyPath} (id ${deployKeyId}) is registered on ${repo} and the SSH auth ` +
        `preflight is green — L1 active`,
    ];
    actions.push(...(await checkDefaultBranchProtectionAction(run, repo)));
    return actions;
  }

  const reasons: string[] = [];
  if (!localFileOk) reasons.push(`local key file missing at ${deployKeyPath}`);
  if (!idListed) reasons.push(`recorded id ${deployKeyId} not found on ${repo}'s registered deploy keys`);
  if (localFileOk && !probe.ok) reasons.push(`SSH auth preflight failed${probe.detail ? `: ${probe.detail}` : ""}`);
  const staleForeign = listedKeys.filter((k) => isSapwoodWorkerTitle(k.title) && k.id !== deployKeyId);
  return armAuthFailsStaleOrMismatch(run, repo, cwd, configFilePath, staleForeign, reasons, deps);
}

/** #606 gate② round 1 (OWNER RULING) orchestrator: (deployKeyPath, deployKeyId) BOTH configured
 *  -> reconcile; NEITHER configured with no sapwood-titled remote key -> fresh provisioning
 *  (ssh-keygen -> `gh repo deploy-key add --allow-write --title sapwood-worker` -> read back the
 *  new key's id -> preflight -> write BOTH deployKeyPath/deployKeyId -> gitignore guarantee ->
 *  branch-protection check); NEITHER configured but a sapwood-titled key already exists remotely
 *  (this machine has no recorded anchor for it) -> the auth-fails/stale/mismatch arm, same as a
 *  reconcile failure (never assume ownership from a title alone). Every failure degrades to an
 *  L0 guidance-carrying WARN (never a thrown error) — `init()` itself never fails because L1
 *  provisioning didn't complete. */
async function ensureDeployKey(
  cfg: SapwoodConfig,
  run: GhRunner,
  repo: string,
  cwd: string,
  configFilePath: string | null,
  deps: Pick<InitDeps, "sshKeygen" | "probeSshAuth" | "isInteractive" | "promptOperator" | "hostname">,
): Promise<string[]> {
  const { deployKeyPath, deployKeyId } = cfg.worker;

  if (deployKeyPath !== undefined && deployKeyId !== undefined) {
    return reconcileDeployKey(run, repo, cwd, configFilePath, deployKeyPath, deployKeyId, deps);
  }

  const keyPath = join(cwd, "data", "worker-deploy-key");
  let existingKeys: DeployKeyListEntry[];
  try {
    existingKeys = parseDeployKeys(await run(["repo", "deploy-key", "list", "-R", repo, "--json", "id,title"]));
  } catch (e) {
    return [deployKeyProvisioningFailedAction(repo, keyPath, DEPLOY_KEY_TITLE, e)];
  }
  const priorSapwoodKeys = existingKeys.filter((k) => isSapwoodWorkerTitle(k.title));
  if (priorSapwoodKeys.length > 0) {
    // A sapwood-titled key exists remotely, but THIS machine has no recorded (path, id) anchor
    // for it — per the owner ruling, a title is never authoritative for "mine": it may validly
    // belong to a different machine/operator. Never assume ownership, never touch it.
    return armAuthFailsStaleOrMismatch(run, repo, cwd, configFilePath, priorSapwoodKeys, [], deps);
  }

  // Fresh provisioning: nothing configured locally, nothing sapwood-titled remotely.
  const actions: string[] = [];
  try {
    if (!existsSync(keyPath)) {
      mkdirSync(dirname(keyPath), { recursive: true });
      await deps.sshKeygen(keyPath);
    }
    actions.push(...ensureGitignoreCoversDeployKeyAction(cwd, keyPath));
    await run(["repo", "deploy-key", "add", `${keyPath}.pub`, "-R", repo, "--allow-write", "--title", DEPLOY_KEY_TITLE]);
  } catch (e) {
    actions.push(deployKeyProvisioningFailedAction(repo, keyPath, DEPLOY_KEY_TITLE, e));
    return actions;
  }
  actions.push(`deploy key: added write deploy key "${DEPLOY_KEY_TITLE}" to ${repo}`);

  let newId: number | undefined;
  try {
    const listed = parseDeployKeys(await run(["repo", "deploy-key", "list", "-R", repo, "--json", "id,title"]));
    // Match by title AND public-key content when available; title match alone is acceptable for
    // the key just added above.
    newId = listed.find((k) => k.title === DEPLOY_KEY_TITLE)?.id;
  } catch {
    /* fall through to the "id unresolved" WARN below */
  }
  if (newId === undefined) {
    actions.push(
      `deploy key: WARN — registered "${DEPLOY_KEY_TITLE}" on ${repo} but could not read back its id from ` +
        `\`gh repo deploy-key list\`; worker.deployKeyId was NOT written. Find the id in the repo's Settings -> ` +
        `Deploy keys page and set worker.deployKeyId by hand, alongside worker.deployKeyPath: ${keyPath}.`,
    );
    return actions;
  }

  const probe = await deps.probeSshAuth(keyPath);
  if (!probe.ok) {
    actions.push(deployKeyPreflightFailedAction(keyPath, probe.detail));
    return actions;
  }
  actions.push(`deploy key: SSH auth preflight OK for ${keyPath}`);

  if (configFilePath === null) {
    actions.push("deploy key: WARN — no config file found to write worker.deployKeyPath/worker.deployKeyId into; set them by hand.");
  } else if (configFilePath.endsWith(".json")) {
    actions.push(
      `deploy key: worker.deployKeyPath/worker.deployKeyId NOT written — ${configFilePath} is JSON, not YAML; add ` +
        `"worker": { "deployKeyPath": "${relative(dirname(configFilePath), keyPath)}", "deployKeyId": ${newId} } by hand.`,
    );
  } else {
    actions.push(...writeDeployKeyConfigIntoYaml(configFilePath, relative(dirname(configFilePath), keyPath), newId));
  }

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

  // #606 (#351 final ruling): L1 scoped-worker-identity deploy key — provisioned AFTER the
  // config file exists (ensureConfig above), since a fresh onboarding needs somewhere to write
  // worker.deployKeyPath into. Every failure degrades to a guidance-carrying WARN; init() itself
  // never fails because L1 provisioning didn't complete (engine stays fully functional at L0).
  actions.push(
    ...(await ensureDeployKey(cfg, run, repo, cwd, resolveActiveConfigPath(cwd, written), {
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
