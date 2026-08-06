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
import { dirname, isAbsolute, join, relative } from "node:path";
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

// ---- #606 gate② round 1+2 (#351 final ruling; OWNER RULING supersedes the title-only design):
// L1 scoped-worker-identity deploy-key provisioning, anchored on the LOCAL (deployKeyPath,
// deployKeyId) pair. The engine never invokes or scripts remote deploy-key deletion — the bare
// remote title may validly belong to a different machine/operator, so a foreign or stale key is
// only ever surfaced in a WARN for a HUMAN to review, never touched by this file. ---------------

// Exported (#671): deploy-key-startup-check.ts's "missing/unreadable key file" arm reuses this
// as the generic title argument to deployKeyProvisioningFailedAction below — the same guidance
// string `sapwood init` itself would produce for the same failure shape.
export const DEPLOY_KEY_TITLE = "sapwood-worker";

export interface DeployKeyListEntry {
  id: number;
  title: string;
  // #606 gate② round 2 (R3-1): the registered PUBLIC key content, when `gh` reports it
  // (`--json id,title,key`) — optional because not every caller requests it (the id/title-only
  // callers have no use for it and keep the smaller argv/response). Used by reconcileDeployKey
  // to prove the (path, id) pair is genuinely the SAME key, not merely "an id that happens to be
  // registered" plus "a local key that happens to authenticate" independently.
  key?: string;
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
    if (typeof id === "number" && typeof title === "string") out.push({ id, title, ...(typeof key === "string" ? { key } : {}) });
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
 *  `<hostComponent>-2`, `<hostComponent>-3`, ... and returns the first suffix where BOTH the
 *  local key path is free AND the title isn't among `knownRemoteTitles`; path and title always
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
    const path = join(cwd, "data", `worker-deploy-key-${candidateHost}`);
    const title = `${DEPLOY_KEY_TITLE}-${candidateHost}`;
    if (!existsSync(path) && !knownRemoteTitles.has(title)) return { path, title };
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
// Exported (#671): deploy-key-startup-check.ts's "preflight fails" arm reuses this EXACT wording
// rather than writing a third guidance variant — see that module's own doc.
export function deployKeyPreflightFailedAction(keyPath: string, detail: string | undefined): string {
  return (
    `deploy key: WARN — SSH auth preflight failed for ${keyPath}${detail ? `: ${detail}` : ""}. Engine stays at ` +
    `L0 (full credentialed worker env) until this passes. Fix: confirm ${keyPath} is a readable private key ` +
    `matching the deploy key registered on the repo, then re-run "sapwood init" to re-check the preflight. ` +
    `See docs/security.md's worker credential tiers.`
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

const WORKER_BLOCK_LINE = /^worker:\s*(#.*)?$/;
const WORKER_FLOW_LINE = /^worker:\s*\{/;
// Content-only regexes (matched against a line's text AFTER its exact direct-child indent has
// already been stripped by isDirectChildAnchorLine — see that function's own doc for why this
// is indent-EXACT, not "any indent"). Never matched against a whole raw line, and never scanned
// across the whole file — only within a `worker:` block's own direct-child lines (R3-4).
const DEPLOY_KEY_PATH_LINE = /^deployKeyPath:/;
const DEPLOY_KEY_ID_LINE = /^deployKeyId:/;
// Loose, UNANCHORED substring checks — deliberately used ONLY against a single already-matched
// flow-style `worker: { ... }` line (never scanned across the whole file), since
// `deployKeyPath:`/`deployKeyId:` inside a flow mapping is not at the start of that line.
const DEPLOY_KEY_PATH_TOKEN = /deployKeyPath\s*:/;
const DEPLOY_KEY_ID_TOKEN = /deployKeyId\s*:/;

/** #606 gate② round 2 (R3-4), round 3: the top-level `worker:` block's OWN body — the run of
 *  lines strictly indented deeper than `worker:` itself, stopping at the first non-blank line
 *  that ISN'T indented (a sibling top-level key) or at EOF. `start` is the index of the
 *  `worker:` line; body lines are the half-open range `(start, end)`. `childIndent` is the
 *  leading-whitespace CHARACTER COUNT of the block's first non-blank child line (normally 2) —
 *  undefined when the block has no non-blank child line at all. Returns null when no top-level
 *  (block-style) `worker:` line exists.
 *
 *  Round 3 fix: knowing `childIndent` is what lets isDirectChildAnchorLine require EXACT indent
 *  equality rather than "any indent at all" — a round-2 gap where a MORE deeply indented line
 *  (e.g. the body of a `worker.promptFile: |` block scalar that happens to contain the literal
 *  text "deployKeyPath: ..." as prose, at 4+ spaces under a 2-space `promptFile:` child) was
 *  wrongly treated as this repo's own anchor line and silently stripped by both write and
 *  clear. */
function findWorkerBlockRange(lines: string[]): { start: number; end: number; childIndent: number | undefined } | null {
  const start = lines.findIndex((l) => WORKER_BLOCK_LINE.test(l));
  if (start === -1) return null;
  let end = lines.length;
  let childIndent: number | undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue; // a blank line doesn't end the block
    if (!/^[ \t]/.test(line)) {
      end = i;
      break;
    }
    if (childIndent === undefined) childIndent = /^[ \t]*/.exec(line)![0].length;
  }
  return { start, end, childIndent };
}

/** #606 gate② round 3 (item 2): true when `line` is a DIRECT CHILD of the worker: block —
 *  EXACTLY `childIndent` leading whitespace characters, no more, no less — whose content (after
 *  that exact indent is stripped) is a `deployKeyPath:`/`deployKeyId:` anchor. A line indented
 *  DEEPER than `childIndent` is nested content (e.g. a block scalar's own body) and must never
 *  match, however coincidentally its text resembles an anchor line. */
function directChildContent(line: string, childIndent: number): string | null {
  const indent = /^[ \t]*/.exec(line)![0].length;
  return indent === childIndent ? line.slice(indent) : null;
}

function isDirectChildAnchorLine(line: string, childIndent: number): boolean {
  const content = directChildContent(line, childIndent);
  return content !== null && (DEPLOY_KEY_PATH_LINE.test(content) || DEPLOY_KEY_ID_LINE.test(content));
}

/** #606 gate② round 3 (item 2): true when the worker: block (lines strictly after `start`, up
 *  to the first sibling top-level key or EOF) still has ANY remaining direct-child content once
 *  the anchor lines have already been filtered out of `lines` — blank lines and comment-only
 *  lines are skipped (neither is a real YAML mapping entry, so neither justifies keeping the
 *  `worker:` header on its own), and the scan covers the WHOLE remaining block range, not just
 *  the line immediately after `start` (round 2's gap: a blank line — or a comment — between
 *  `worker:` and its next real child, e.g. `model:`, made this probe false-negative and restore
 *  a stale anchor that should have cleared). */
function blockHasRemainingChild(lines: string[], start: number): boolean {
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue; // blank — not a child, keep scanning
    if (!/^[ \t]/.test(line)) return false; // a sibling top-level key — the block ended with nothing left
    if (line.trim().startsWith("#")) continue; // comment-only — not a mapping entry, keep scanning
    return true; // real content remains
  }
  return false;
}

/** #606 gate② round 1 (P1-2/P2-8), round 2 (R3-4): writes BOTH `worker.deployKeyPath` and
 *  `worker.deployKeyId` — the local (path, id) anchor pair the owner ruling's reconcile/
 *  idempotence logic keys on, never the bare title. Surgical text edit, NOT a parse->stringify
 *  round trip — this repo's own config is hand-edited, heavily commented YAML (CLAUDE.md's
 *  locked decision), and a full re-serialize would destroy every comment in it.
 *
 *  P2-8 hardening: (i) a top-level `worker:` line MAY carry a trailing comment (`worker: # a
 *  note`) — matched (WORKER_BLOCK_LINE), not just the bare `worker:` the superseded version
 *  required exactly. (ii) a FLOW-style `worker: { ... }` mapping is never edited — inserting a
 *  block-style child under it risks invalid YAML this function cannot verify by regex alone, so
 *  it returns a hand-edit WARN instead of guessing. (iii) after writing, the file is RE-READ and
 *  re-parsed with parseConfig(); if that fails, or the keys didn't actually land as written, the
 *  ORIGINAL bytes are restored and a hand-edit WARN is returned — an honest fallback, never a
 *  corrupted config file left behind.
 *
 *  R3-4 scoping: any PRIOR `deployKeyPath:`/`deployKeyId:` lines are stripped first (so this is
 *  also the "replace" path for a fresh key superseding a cleared stale one), but ONLY within the
 *  `worker:` block's own body (findWorkerBlockRange) — a same-shaped line anywhere else in the
 *  file (e.g. inside an unrelated block scalar) is never touched. */
export function writeDeployKeyConfigIntoYaml(configFilePath: string, relativeKeyPath: string, keyId: number): string[] {
  const original = readFileSync(configFilePath, "utf8");
  const lines = original.split("\n");
  if (lines.some((l) => WORKER_FLOW_LINE.test(l))) {
    return [
      `deploy key: worker.deployKeyPath/worker.deployKeyId NOT written — ${configFilePath} uses a flow-style ` +
        `"worker: { ... }" mapping this tool won't safely edit; add "deployKeyPath: ${relativeKeyPath}" and ` +
        `"deployKeyId: ${keyId}" inside it by hand.`,
    ];
  }
  const comment = "# #606 gate② round 1: L1 write deploy key (path, id) — the local anchor; git transport only, no forge API credential";
  const newLines = [`  deployKeyPath: ${relativeKeyPath} ${comment}`, `  deployKeyId: ${keyId}`];
  const range = findWorkerBlockRange(lines);
  let edited: string;
  if (range === null) {
    const trimmed = original.replace(/\n+$/, "");
    edited = `${trimmed}\n\nworker:\n${newLines.join("\n")}\n`;
  } else {
    // Strip any EXISTING deployKeyPath:/deployKeyId: lines, but ONLY the block's own DIRECT
    // CHILDREN (exact childIndent — round 3) inside its body (R3-4) — nothing outside
    // [start+1, end) is ever inspected or removed, and nothing MORE deeply indented than
    // childIndent (nested content, e.g. a block scalar's own body) is ever mistaken for an
    // anchor line. `range.start`'s own index is unchanged by this filter (every removal happens
    // strictly after it) and remains valid as the insertion point below.
    const childIndent = range.childIndent;
    const withoutOldKeysInBlock = lines.filter((l, i) => {
      if (i <= range.start || i >= range.end) return true;
      if (childIndent === undefined) return true;
      return !isDirectChildAnchorLine(l, childIndent);
    });
    const out = [...withoutOldKeysInBlock];
    out.splice(range.start + 1, 0, ...newLines);
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

/** #606 gate② round 1 (owner ruling), round 2 (R3-2/R3-4): removes `worker.deployKeyPath`/
 *  `worker.deployKeyId` from a YAML config file. Called BEFORE either sub-choice of the
 *  auth-fails/stale/mismatch arm — a reconcile failure proves the recorded anchor is stale/
 *  wrong, and the ruling requires clearing it in BOTH outcomes: choice (a) replaces it with a
 *  freshly-provisioned pair; choice (b) leaves the config with NO anchor at all, so the NEXT
 *  `sapwood init` run takes the fresh-provisioning path instead of re-reconciling the same
 *  broken values forever (this is what makes "re-run sapwood init" an honest instruction —
 *  P1-5). A no-op (returns no actions) when the worker: block already carries neither key.
 *
 *  R3-4: both the presence check and the strip filter are scoped to the top-level `worker:`
 *  block's own body (findWorkerBlockRange) — never a whole-file scan, which would also strip (or
 *  false-negative on) a same-shaped line inside an unrelated block scalar elsewhere in the file.
 *
 *  R3-2: a flow-style `worker: { ... }` line is checked SEPARATELY (a substring test on that one
 *  line, since `deployKeyPath:`/`deployKeyId:` there never starts the line) — if it carries
 *  either key, this returns the hand-edit WARN and clears NOTHING (never claims cleared); if it
 *  doesn't, there is nothing block-style to find either, so this is a correct no-op. Same P2-8
 *  read-back-and-restore safety net as writeDeployKeyConfigIntoYaml for the block-style path. */
export function clearDeployKeyConfigFromYaml(configFilePath: string): string[] {
  const original = readFileSync(configFilePath, "utf8");
  const lines = original.split("\n");
  const flowWorkerLine = lines.find((l) => WORKER_FLOW_LINE.test(l));
  if (flowWorkerLine !== undefined) {
    if (DEPLOY_KEY_PATH_TOKEN.test(flowWorkerLine) || DEPLOY_KEY_ID_TOKEN.test(flowWorkerLine)) {
      return [
        `deploy key: worker.deployKeyPath/worker.deployKeyId NOT cleared — ${configFilePath} uses a flow-style ` +
          `"worker: { ... }" mapping this tool won't safely edit; remove deployKeyPath/deployKeyId from it by hand.`,
      ];
    }
    return []; // flow-style worker:, but no deploy-key anchor inside it — nothing to clear
  }
  const range = findWorkerBlockRange(lines);
  const childIndent = range?.childIndent;
  const directChildContents =
    range !== null && childIndent !== undefined
      ? lines
          .slice(range.start + 1, range.end)
          .map((l) => directChildContent(l, childIndent))
          .filter((c): c is string => c !== null)
      : [];
  const hasPath = directChildContents.some((c) => DEPLOY_KEY_PATH_LINE.test(c));
  const hasId = directChildContents.some((c) => DEPLOY_KEY_ID_LINE.test(c));
  if (!hasPath && !hasId) return [];
  const start = range!.start;
  const end = range!.end;
  const withoutKeys = lines.filter((l, i) => {
    if (i <= start || i >= end) return true;
    return !isDirectChildAnchorLine(l, childIndent!);
  });
  // If deployKeyPath/deployKeyId were the ONLY children under worker:, stripping them leaves a
  // bare `worker:` with an implicit YAML null value — which FAILS z.object()'s validation
  // (`.default({})` only substitutes for an ABSENT/undefined key, never an explicit null) and
  // would always trip the read-back check below. Prune the now-empty `worker:` line itself in
  // that case (its index, `start`, is unchanged by the filter above — every removal happens
  // strictly after it), so the key is genuinely ABSENT (parses as undefined -> the schema
  // default). Round 3 fix: scans the WHOLE remaining block range for any real (non-blank,
  // non-comment) direct child, not just the single line immediately after `start` — a blank
  // line (or a comment) between `worker:` and its next real child no longer causes a false
  // "nothing left" negative that would restore a stale anchor.
  const hasChild = blockHasRemainingChild(withoutKeys, start);
  const edited = (!hasChild ? withoutKeys.filter((_, i) => i !== start) : withoutKeys).join("\n");
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

/** #606 gate② round 2 (R3-2): the JSON-config half of clearDeployKeyConfigFromYaml — a plain
 *  parse -> delete `worker.deployKeyPath`/`worker.deployKeyId` -> re-serialize (2-space indent)
 *  -> re-parse-and-verify round trip is safe here (unlike the YAML path) because JSON carries no
 *  comments to destroy. Drops the `worker` key entirely when it becomes empty (mirrors the YAML
 *  path's own empty-block pruning, for the same "an explicit null/empty object still isn't
 *  `undefined`" reason). Same P2-8 read-back-and-restore safety net: any parse/verify failure
 *  restores the ORIGINAL bytes and returns a hand-edit WARN, never a corrupted config file. */
export function clearDeployKeyConfigFromJson(configFilePath: string): string[] {
  const original = readFileSync(configFilePath, "utf8");
  const handEditWarn = (reason: string): string[] => [
    `deploy key: worker.deployKeyPath/worker.deployKeyId NOT cleared — ${configFilePath} ${reason}; remove ` +
      `deployKeyPath/deployKeyId under "worker" by hand.`,
  ];
  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch {
    return handEditWarn("did not parse as JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return handEditWarn("does not have an object at its top level");
  }
  const obj = parsed as Record<string, unknown>;
  const worker = obj.worker;
  if (typeof worker !== "object" || worker === null || Array.isArray(worker)) {
    return []; // no worker object at all (or a malformed one z.object() would reject anyway) — nothing this function can clear
  }
  const workerObj = { ...(worker as Record<string, unknown>) };
  if (!("deployKeyPath" in workerObj) && !("deployKeyId" in workerObj)) return [];
  delete workerObj.deployKeyPath;
  delete workerObj.deployKeyId;
  const nextObj: Record<string, unknown> = { ...obj };
  if (Object.keys(workerObj).length === 0) {
    delete nextObj.worker;
  } else {
    nextObj.worker = workerObj;
  }
  const edited = `${JSON.stringify(nextObj, null, 2)}\n`;
  writeFileSync(configFilePath, edited);
  try {
    const reparsed = parseConfig(readFileSync(configFilePath, "utf8"));
    if (reparsed.worker.deployKeyPath !== undefined || reparsed.worker.deployKeyId !== undefined) {
      throw new Error("deployKeyPath/deployKeyId still present after clearing");
    }
  } catch {
    writeFileSync(configFilePath, original);
    return handEditWarn("did not parse back cleanly after an automated edit — the ORIGINAL file was restored untouched");
  }
  return [`deploy key: cleared the stale worker.deployKeyPath/worker.deployKeyId anchor from ${configFilePath}`];
}

/** #606 gate② round 2 (R3-2): dispatches to the JSON or YAML anchor-clearing function by the
 *  config file's own extension — the SAME `.json` test `writeDeployKeyConfigIntoYaml`'s callers
 *  already use to route writes. */
function clearDeployKeyConfig(configFilePath: string): string[] {
  return configFilePath.endsWith(".json") ? clearDeployKeyConfigFromJson(configFilePath) : clearDeployKeyConfigFromYaml(configFilePath);
}

const GITIGNORE_DEPLOY_KEY_RULE = "/data/worker-deploy-key*";
const GITIGNORE_DEPLOY_KEY_COMMENT = "# sapwood: worker deploy key(s) — kept out of `git add -A` (see docs/security.md)";

/** #606 gate② round 1 (P1-6), round 2 (R3-7): keeps the private key out of an ordinary
 *  `git add -A` sweep. gitignore semantics are LAST-MATCH-WINS (a later negation can
 *  re-include a path an earlier rule excluded), so an unordered "is SOME line in the file
 *  covering this path" check is bypassable — this deliberately does NOT implement a full
 *  gitignore evaluator. Instead: ensure the exact rooted rule `/data/worker-deploy-key*` (a
 *  single pattern covering every key this file ever provisions — the base path and every
 *  per-host/numeric-suffixed sibling arm (a) can mint, plus each key's `.pub` counterpart) is
 *  the file's LAST effective non-blank line; append it (with its own comment) at EOF if it
 *  isn't already there EXACTLY. Appending at EOF always wins over anything earlier in the file,
 *  including a negation — the simple mechanism this repo's doctrine prefers over a bespoke
 *  evaluator. Idempotent: a repeat run whose last line already IS the exact rule is a true
 *  no-op. Best-effort: a failure here is a WARN, never a reason to fail init.
 *
 *  Round 3 fix (item 1): the equality check against the last non-blank line is RAW byte
 *  equality, never `.trim()`ed — gitignore treats leading whitespace on a pattern line as part
 *  of the pattern itself (not decorative indentation the way YAML/most config formats treat
 *  it), so a line reading `  /data/worker-deploy-key*` (leading spaces) is a DIFFERENT,
 *  non-matching pattern to git and does NOT actually ignore the key — trimming before comparing
 *  would have falsely treated that as "already covered" and left the key unignored. */
function ensureGitignoreCoversDeployKeyAction(cwd: string): string[] {
  const gitignorePath = join(cwd, ".gitignore");
  try {
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    const lines = existing.split("\n");
    let lastNonBlankIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      // `.trim()` here is ONLY to detect whether the line is blank (decides which line is
      // "last"), never used for the equality check below.
      if (lines[i]!.trim().length > 0) {
        lastNonBlankIdx = i;
        break;
      }
    }
    if (lastNonBlankIdx !== -1 && lines[lastNonBlankIdx] === GITIGNORE_DEPLOY_KEY_RULE) {
      return [];
    }
    const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
    const addition = `${GITIGNORE_DEPLOY_KEY_COMMENT}\n${GITIGNORE_DEPLOY_KEY_RULE}\n`;
    writeFileSync(gitignorePath, `${existing}${needsLeadingNewline ? "\n" : ""}${addition}`);
    return [
      `deploy key: appended "${GITIGNORE_DEPLOY_KEY_RULE}" as the last rule in ${gitignorePath}, so an ordinary ` +
        `"git add -A" will not stage the worker deploy key(s) (a deliberate "git add -f" still can)`,
    ];
  } catch (e) {
    return [
      `deploy key: WARN — could not update ${gitignorePath} to ignore the worker deploy key(s) (${
        e instanceof Error ? e.message : String(e)
      }). Add "${GITIGNORE_DEPLOY_KEY_RULE}" as the LAST line of .gitignore by hand.`,
    ];
  }
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

/** #606 gate② round 1 (OWNER RULING — supersedes the previous title-only-idempotence amendment),
 *  round 2 (R3-1/R3-2/R3-3): the reconcile failure / no-recorded-anchor state. The engine never
 *  invokes or scripts remote deploy-key deletion or modification — the remote inventory is never
 *  authoritative for "mine"; a `sapwood-worker`-titled key may validly belong to a different
 *  machine/operator, so this machine can only ever ADD a new key of its own. Stale/foreign keys
 *  are surfaced in the WARN for a HUMAN to review, never touched here. Any prior local
 *  (deployKeyPath, deployKeyId) anchor is cleared FIRST (clearDeployKeyConfig — JSON or YAML, by
 *  the config file's own format) in both sub-choices, so a later `sapwood init` re-run never
 *  keeps reconciling against a value already proven stale — the WARN's "re-run sapwood init"
 *  advice actually converges (P1-5). When the config format itself refuses the clear (a
 *  flow-style YAML mapping), this run's own report still degrades to L0 honestly regardless —
 *  clearing and reporting are independent; a failed clear never blocks the WARN/L0 report below.
 *
 *  WARN + operator choice when `deps.isInteractive()`:
 *  (a) leave every remote key untouched; clear the local anchor; generate a FRESH keypair
 *      (pickFreshArmAKeySlot — never reuses a locally-existing path or a remotely-registered
 *      per-host title); register it as an ADDITIONAL deploy key; record the new (path, id)
 *      (P1-1's before/after id-diff, never a title match); preflight; write config.
 *  (b) leave every remote key untouched; clear the local anchor; proceed degraded at L0.
 *  No TTY -> default (b), the no-write, never-wedge path — the WARN still names (a)'s manual
 *  steps. */
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
  if (configFilePath !== null) {
    actions.push(...clearDeployKeyConfig(configFilePath));
  }

  const reasonText = reasons.length > 0 ? reasons.join("; ") : "no local (path, id) anchor recorded for this machine";
  const staleNote =
    staleForeignKeys.length > 0
      ? ` Existing sapwood-titled key(s) already on ${repo} — left untouched (verify/clean up by hand if any are ` +
        `stale): ${staleForeignKeys.map((k) => `"${k.title}" (id ${k.id})`).join(", ")}.`
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
  // Round 3 fix (item 3): pickFreshArmAKeySlot now THROWS on exhaustion (no more Date.now()
  // fallback) — folded into the SAME try/catch as keygen/gitignore/add below so that failure
  // degrades exactly like any other provisioning failure. `fallbackKeyPath`/`fallbackTitle` (the
  // UN-suffixed base candidate) name the WARN's manual steps when slot-picking itself is what
  // failed, since `keyPath`/`title` never get assigned in that case.
  const fallbackKeyPath = join(cwd, "data", `worker-deploy-key-${hostComponent}`);
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
    mkdirSync(dirname(keyPath), { recursive: true });
    await deps.sshKeygen(keyPath);
    actions.push(...ensureGitignoreCoversDeployKeyAction(cwd));
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

/** #606 gate② round 1 (OWNER RULING), round 2 (R3-1): both `worker.deployKeyPath` AND
 *  `worker.deployKeyId` configured — RECONCILE (never skip, unlike the superseded version, which
 *  returned immediately once `deployKeyPath` was set and so could never actually detect or
 *  recover from a stale/rotated/mismatched key — P1-5). FOUR checks, ALL must be green: the
 *  local key file exists; the recorded id is present in `gh repo deploy-key list`; that
 *  id-matched remote entry's OWN public key content matches the local `.pub` file (R3-1 — proves
 *  the (path, id) pair is genuinely the SAME key that was recorded together, not merely "an id
 *  that happens to be registered" plus "a local key that happens to authenticate" independently,
 *  which a hand-edited or foreign id sharing a DIFFERENT but also-registered key could otherwise
 *  fake); the SSH preflight succeeds. All green -> a positive confirmation action line (+
 *  branch-protection check). Any failure -> the auth-fails/stale/mismatch arm
 *  (armAuthFailsStaleOrMismatch). */
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
  let matchedEntry: DeployKeyListEntry | undefined;
  try {
    listedKeys = parseDeployKeys(await run(["repo", "deploy-key", "list", "-R", repo, "--json", "id,title,key"]));
    matchedEntry = listedKeys.find((k) => k.id === deployKeyId);
  } catch {
    matchedEntry = undefined;
  }
  const idListed = matchedEntry !== undefined;

  // R3-1: cross-check the LOCAL public key file's content against the id-matched remote entry's
  // own `key` field — "the id is registered" alone doesn't prove THIS local file is the key
  // behind it.
  let keyContentMatches = false;
  if (idListed && localFileOk) {
    try {
      const localPub = normalizePublicKey(readFileSync(`${deployKeyPath}.pub`, "utf8"));
      keyContentMatches = matchedEntry?.key !== undefined && localPub === normalizePublicKey(matchedEntry.key);
    } catch {
      keyContentMatches = false;
    }
  }

  const probe = localFileOk ? await deps.probeSshAuth(deployKeyPath) : { ok: false, detail: "local key file missing" };

  if (localFileOk && idListed && keyContentMatches && probe.ok) {
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
  if (idListed && localFileOk && !keyContentMatches) {
    reasons.push(
      `the local key at ${deployKeyPath} does not match the public key registered under id ${deployKeyId} — the ` +
        `recorded (path, id) pair no longer refers to the same key`,
    );
  }
  if (localFileOk && !probe.ok) reasons.push(`SSH auth preflight failed${probe.detail ? `: ${probe.detail}` : ""}`);
  const staleForeign = listedKeys.filter((k) => isSapwoodWorkerTitle(k.title));
  return armAuthFailsStaleOrMismatch(run, repo, cwd, configFilePath, staleForeign, reasons, deps);
}

/** #606 gate② round 1 (OWNER RULING) orchestrator: (deployKeyPath, deployKeyId) BOTH configured
 *  -> reconcile; NEITHER configured with no sapwood-titled remote key -> fresh provisioning
 *  (ssh-keygen -> `gh repo deploy-key add --allow-write --title sapwood-worker` -> read back the
 *  new key's id via a before/after id diff, never a title match (R3-1) -> preflight -> write
 *  BOTH deployKeyPath/deployKeyId -> gitignore guarantee -> branch-protection check); NEITHER
 *  configured but a sapwood-titled key already exists remotely (this machine has no recorded
 *  anchor for it) -> the auth-fails/stale/mismatch arm, same as a reconcile failure (never
 *  assume ownership from a title alone). Every failure degrades to an L0 guidance-carrying WARN
 *  (never a thrown error) — `init()` itself never fails because L1 provisioning didn't
 *  complete. */
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
  let newId: number;
  try {
    if (!existsSync(keyPath)) {
      mkdirSync(dirname(keyPath), { recursive: true });
      await deps.sshKeygen(keyPath);
    }
    actions.push(...ensureGitignoreCoversDeployKeyAction(cwd));
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
