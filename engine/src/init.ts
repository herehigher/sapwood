// `sapwood init` — credible, idempotent, recovery-safe onboarding. Automates the manual
// GitHub setup 0day left to the human (bootstrap_github.sh:89 just says "make the board
// by hand"). Detect-before-create everywhere, so re-running is always safe.
//
// Steps: auth preflight -> user-vs-org -> ensure labels -> ensure milestones ->
// ensure ProjectV2 board (Status lanes) -> write starter config.
// The guard PreToolUse hook is wired in M1 (guard.ts does not exist yet) — deferred here
// with a clear note, and is human-merge-only per CLAUDE.md.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ConfigSchema, type SapwoodConfig } from "./config.js";
import { gh, ghText, type GhRunner } from "./gh.js";
import type { OwnerKind } from "./forge.js";

export interface InitDeps {
  run: GhRunner; // generic gh runner (label/milestone/api/graphql)
  getAuthStatus: () => Promise<string>; // `gh auth status` text (stdout+stderr)
  cwd: string; // where to write the starter config
}

const defaultDeps = (): InitDeps => ({
  run: gh,
  getAuthStatus: () => ghText(["auth", "status"]),
  cwd: process.cwd(),
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

export interface LabelSpec {
  name: string;
  color: string; // 6-hex, no '#'
  description: string;
}

/** The label taxonomy the loop depends on, derived from config (no literals hidden in code). */
export function requiredLabels(cfg: SapwoodConfig): LabelSpec[] {
  const l = cfg.labels;
  return [
    { name: "type:feature", color: "1d76db", description: "Feature work (1 issue = 1 PR)" },
    { name: "type:bug", color: "d73a4a", description: "Defect" },
    { name: "type:infra", color: "6e7781", description: "Infra / CI / tooling" },
    { name: "type:docs", color: "0075ca", description: "Documentation" },
    { name: "prio:0", color: "b60205", description: "Priority 0 — governance/blocking (highest)" },
    { name: "prio:1", color: "d93f0b", description: "Priority 1 — high" },
    { name: "prio:2", color: "fbca04", description: "Priority 2 — medium" },
    { name: "prio:3", color: "0e8a16", description: "Priority 3 — feature (default)" },
    { name: l.inProgress, color: "0e8a16", description: "Claimed by a worker (in flight)" },
    { name: l.needsHuman, color: "5319e7", description: "Escalated — stop autonomy, ask a human" },
    { name: l.blocked, color: "5319e7", description: "Blocked — held out of the main lane" },
    { name: l.reserve, color: "5319e7", description: "Reserve — not in the main dispatch lane" },
    { name: l.verifyNa, color: "c5def5", description: "Verification N/A — skips the Decision #8 gate" },
  ];
}

// ---- gh-backed steps (integration-level; thin) ----------------------------------

export class InitError extends Error {}

/** Throw an actionable error if not authenticated or missing the `project` scope. */
export async function preflight(getAuthStatus: () => Promise<string>): Promise<void> {
  const text = await getAuthStatus();
  const loggedIn = /logged in to/i.test(text) && !/not logged in/i.test(text);
  if (!loggedIn) {
    throw new InitError("not logged in to GitHub — run: gh auth login");
  }
  if (!parseAuthScopes(text).includes("project")) {
    throw new InitError("missing `project` token scope — run: gh auth refresh -s project");
  }
}

async function ensureLabels(cfg: SapwoodConfig, run: GhRunner, repo: string): Promise<string[]> {
  const existing = JSON.parse(
    await run(["label", "list", "--repo", repo, "--limit", "200", "--json", "name"]),
  ) as { name: string }[];
  const have = existing.map((e) => e.name);
  const toCreate = requiredLabels(cfg).filter((l) => !have.includes(l.name));
  for (const l of toCreate) {
    // No --force: detect-before-create preserves any color/description the user customized.
    await run(["label", "create", l.name, "--repo", repo, "--color", l.color, "--description", l.description]);
  }
  return toCreate.map((l) => l.name);
}

async function ensureMilestones(cfg: SapwoodConfig, run: GhRunner, repo: string): Promise<string[]> {
  if (cfg.milestones.length === 0) return [];
  const existing = JSON.parse(
    await run(["api", `repos/${repo}/milestones`, "--paginate", "--jq", "[.[].title]"]),
  ) as string[];
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
      field(name:$status){ ... on ProjectV2SingleSelectField { id options{ name color } } } } } }`;
  const out = await run([
    "api", "graphql", "-f", `query=${q}`,
    "-F", `owner=${cfg.board.owner}`, "-F", `num=${cfg.board.projectNumber}`,
    "-F", `status=${cfg.board.statusField}`,
  ]);
  const proj = (JSON.parse(out)?.data?.[root]?.projectV2) as
    | { id: string; field?: { id: string; options: BoardOption[] } | null }
    | null;
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
  const desired = [cfg.board.status.ready, cfg.board.status.inProgress, cfg.board.status.done];
  if (!board.exists) {
    return [
      `board: no ProjectV2 #${cfg.board.projectNumber} found for ${cfg.board.owner}. ` +
        `Create one (gh project create --owner ${cfg.board.owner} --title sapwood), set ` +
        `board.projectNumber in config, and re-run init to provision its Status lanes (${desired.join(", ")}).`,
    ];
  }
  if (!board.statusFieldId) {
    return [`board: ProjectV2 #${cfg.board.projectNumber} has no "${cfg.board.statusField}" single-select field; add it in the UI, then re-run.`];
  }
  const need = missing(desired, board.options.map((o) => o.name));
  if (need.length === 0) return [];
  // updateProjectV2Field replaces the FULL option set, so resend the existing lanes
  // (preserving their colors) plus the new ones (default GRAY) — never clobber a lane.
  const full: BoardOption[] = [...board.options, ...need.map((name) => ({ name, color: "GRAY" }))];
  await run(setStatusOptionsArgs(board.statusFieldId, full));
  return need.map((n) => `board: added Status lane "${n}"`);
}

const VALID_OPTION_COLORS = new Set([
  "GRAY", "BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PINK", "PURPLE",
]);

/**
 * argv for setting the full single-select option list on a ProjectV2 Status field.
 * `color` is a GraphQL enum (not a String), so options are inlined: names are JSON-escaped
 * and colors are validated against the known enum set (defensive — they come from the API
 * or our own GRAY default). The field id is bound as a variable.
 */
export function setStatusOptionsArgs(fieldId: string, options: BoardOption[]): string[] {
  const inline = options
    .map((o) => {
      const color = VALID_OPTION_COLORS.has(o.color) ? o.color : "GRAY";
      return `{name:${JSON.stringify(o.name)}, color:${color}, description:""}`;
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
  const sample = join(here, "..", "..", "sapwood.config.yaml");
  if (existsSync(sample)) return readFileSync(sample, "utf8");
  return "board:\n  owner: CHANGEME\n  repo: CHANGEME\n  projectNumber: 0\n";
}

// ---- orchestrator ---------------------------------------------------------------

export interface InitResult {
  actions: string[];
}

/** Run the full init flow. Idempotent: a second run reports zero create actions. */
export async function init(cfg: SapwoodConfig, deps: Partial<InitDeps> = {}): Promise<InitResult> {
  const { run, getAuthStatus, cwd } = { ...defaultDeps(), ...deps };
  ConfigSchema.parse(cfg); // defend the boundary
  const repo = `${cfg.board.owner}/${cfg.board.repo}`;
  const actions: string[] = [];

  await preflight(getAuthStatus);

  const ownerKind = cfg.board.ownerKind ?? (await detectOwnerKind(cfg.board.owner, run));
  actions.push(`owner ${cfg.board.owner} is a ${ownerKind}`);

  const newLabels = await ensureLabels(cfg, run, repo);
  actions.push(newLabels.length ? `created ${newLabels.length} label(s): ${newLabels.join(", ")}` : "labels already present");

  const newMs = await ensureMilestones(cfg, run, repo);
  if (cfg.milestones.length) {
    actions.push(newMs.length ? `created milestone(s): ${newMs.join(", ")}` : "milestones already present");
  }

  actions.push(...(await ensureBoard(cfg, ownerKind, run)));

  const written = ensureConfig(cwd);
  actions.push(written ? `wrote starter config ${written}` : "config already present");

  actions.push("guard hook: deferred to M1 (guard.ts not built yet) — human-merge-only when wired");
  return { actions };
}

async function detectOwnerKind(owner: string, run: GhRunner): Promise<OwnerKind> {
  const out = await run(["api", `users/${owner}`, "--jq", ".type"]);
  return out.trim() === "Organization" ? "org" : "user";
}
