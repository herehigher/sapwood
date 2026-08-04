// skills-plugin.ts — #639: role-session skill injection via an engine-rendered, immutable
// content-hash-named plugin directory, loaded per-session with `claude --plugin-dir <path>`.
//
// WHY: role sessions (worker, architect, po, verification-plan reviewer/drafter, retro, harvest)
// each re-derive the same reference material (the human-merge-only path list, the AC-evidence
// trust tiers) by restating it in their own prompt text — five and four prompt sites
// respectively, per #639's own count — instead of pulling it from ONE canonical home on demand.
// Claude Code skills are a pull-model carrier: a one-line description always loads, the full
// body only on invocation. This module renders the two v1 skills from docs/security.md's own
// marker-delimited sections VERBATIM — it changes no prompt text and authors no new doctrine; it
// only gives a role session a second, on-demand way to read doctrine that already lives in one
// place.
//
// CONTENT-SIDE ONLY (Codex P1-3 concurrency/crash + poison-channel resolutions, #639's own
// design): the render path's only input is docs/security.md, an engine-shipped file — never
// anything issue-body- or PR-derived. A rendered plugin directory is immutable once published
// (content-hash-named, atomic stage->rename, never overwritten) so every session that reads the
// SAME hash sees the SAME bytes for the engine's whole remaining lifetime.
//
// FAIL-CLOSED (promptFile's own #74 stance, reused here): a missing or duplicated marker aborts
// rendering with a naming error — never a silently empty or truncated skill body.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SkillsPluginSpec {
  /** Both the skill's directory name (`skills/<id>/`) and the marker id matched in
   *  docs/security.md (`<!-- sapwood:skill:<id>:start -->` / `:end`). One name, one meaning —
   *  never two independent identifiers to keep in sync. */
  id: string;
  /** SKILL.md frontmatter `description` — the one-line summary ALWAYS loaded for every session a
   *  plugin dir is attached to (the pull-model carrier's whole point); the marker-delimited body
   *  loads only when the skill is invoked. */
  description: string;
}

/** v1: exactly the two skills #639 names. Adding a THIRD is a follow-up issue's job (a wider
 *  render/inject surface), not a config knob — see #639's "no extraDir" ruling: an operator dir
 *  isn't accepted here either, only these two engine-authored, marker-verified extracts. */
export const SKILLS_PLUGIN_SPECS: readonly SkillsPluginSpec[] = [
  {
    id: "human-merge-only-paths",
    description:
      "Which files a sapwood worker must never land a change to (guard.ts, reviewer.ts/merge-driver.ts, sapwood.config.*, " +
      ".claude/settings*.json, .github/workflows/**) and why — extracted verbatim from docs/security.md's " +
      '"Human-merge-only paths" section (generated, do not hand-edit).',
  },
  {
    id: "ac-evidence-tiers",
    description:
      "sapwood's four acceptance-criteria evidence tiers (A engine-verified / B CI-executed / C human-witnessed / " +
      "D producer-side, never acceptance evidence) — extracted verbatim from docs/security.md's " +
      '"Doctrine lines" section (generated, do not hand-edit).',
  },
];

function markerRegex(id: string, edge: "start" | "end"): RegExp {
  const tag = `<!-- sapwood:skill:${id}:${edge} -->`;
  return new RegExp(tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
}

/** Extract the section of `source` between `<!-- sapwood:skill:<id>:start -->` and
 *  `<!-- sapwood:skill:<id>:end -->`, trimmed of the markers' own surrounding blank lines.
 *  FAIL-CLOSED: missing OR duplicated start/end markers throw, naming the id — never a silent
 *  empty extract or a silent "first match wins". */
export function extractMarkedSection(source: string, id: string): string {
  const starts = [...source.matchAll(markerRegex(id, "start"))];
  const ends = [...source.matchAll(markerRegex(id, "end"))];
  if (starts.length === 0) throw new Error(`docs/security.md: missing start marker for skill "${id}" — refusing to render`);
  if (starts.length > 1) throw new Error(`docs/security.md: duplicated start marker for skill "${id}" — refusing to render`);
  if (ends.length === 0) throw new Error(`docs/security.md: missing end marker for skill "${id}" — refusing to render`);
  if (ends.length > 1) throw new Error(`docs/security.md: duplicated end marker for skill "${id}" — refusing to render`);
  const startIdx = starts[0]!.index! + starts[0]![0].length;
  const endIdx = ends[0]!.index!;
  if (endIdx <= startIdx) throw new Error(`docs/security.md: end marker precedes start marker for skill "${id}" — refusing to render`);
  return source.slice(startIdx, endIdx).trim();
}

export interface PluginFile {
  /** Path relative to the plugin directory root, e.g. "skills/human-merge-only-paths/SKILL.md". */
  relPath: string;
  content: string;
}

const PLUGIN_MANIFEST: PluginFile["relPath"] = ".claude-plugin/plugin.json";

/** Build the plugin's file set (manifest + one SKILL.md per spec) from an already-read
 *  docs/security.md string. PURE — no filesystem access — so extraction/rendering is testable
 *  without a real file on disk. Sorted by relPath: the caller hashes this list in this exact
 *  order, so a stable order is what makes the hash deterministic across process runs. */
export function buildSkillsPluginFiles(securityMd: string): PluginFile[] {
  const files: PluginFile[] = [
    {
      relPath: PLUGIN_MANIFEST,
      content: `${JSON.stringify(
        {
          name: "sapwood-role-skills",
          description: "Engine-rendered reference skills for sapwood role sessions (generated, do not hand-edit — #639).",
        },
        null,
        2,
      )}\n`,
    },
  ];
  for (const spec of SKILLS_PLUGIN_SPECS) {
    const body = extractMarkedSection(securityMd, spec.id);
    files.push({
      relPath: `skills/${spec.id}/SKILL.md`,
      content: `---\nname: ${spec.id}\ndescription: ${spec.description}\n---\n\n${body}\n`,
    });
  }
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** Deterministic content hash over the FULL rendered file set (path + content, in the sorted
 *  order buildSkillsPluginFiles already produces) — identical sources always hash identically,
 *  and the hash is the published directory's own name (content-addressed, so "same hash exists
 *  -> same bytes" is true by construction, never merely by convention). */
export function hashPluginFiles(files: readonly PluginFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relPath.length.toString(10));
    hash.update("\n");
    hash.update(file.relPath);
    hash.update("\n");
    hash.update(file.content.length.toString(10));
    hash.update("\n");
    hash.update(file.content);
  }
  return hash.digest("hex");
}

/** Write `files` under `dir` (creating parent directories as needed). Used both by the real
 *  atomic-publish path below and directly by a crash-consistency test to reproduce exactly what
 *  a process that died between "stage" and "publish" (the rename) would have left behind on
 *  disk — a fully-written STAGE directory, at a path the render function itself never returns or
 *  otherwise treats as published. */
export function writePluginFiles(dir: string, files: readonly PluginFile[]): void {
  for (const file of files) {
    const abs = join(dir, file.relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content, "utf8");
  }
}

/** Publish `files` to `<outRoot>/<hash>` atomically: stage into a fresh, uniquely-named sibling
 *  directory, then `renameSync` it into place — the rename is the one visible, atomic state
 *  transition, so a crash at any point before it leaves nothing at the published path (a
 *  half-written stage directory sits, orphaned, under a name argv-building code never
 *  constructs or looks up). A previously-published directory for this exact hash is NEVER
 *  touched: content-addressing means "the same hash already exists" implies "identical bytes
 *  already there", so this returns immediately rather than re-staging or re-renaming — the
 *  AC's "previously published directories byte-untouched" invariant.
 *
 *  Concurrency: two processes racing to publish the SAME hash can both pass the initial
 *  existsSync check and both stage; only one `renameSync` onto `finalDir` wins. The loser's
 *  rename fails (EEXIST/ENOTEMPTY, platform-dependent for a rename onto a non-empty directory) —
 *  caught and treated as success (the winner published byte-identical content, since the hash is
 *  content-derived), never surfaced as an error. Each stage directory carries a
 *  process/randomness-unique suffix (mkdtempSync), so two concurrent stagers never collide with
 *  each other while staging. ponytail: leaked stage directories from a crash or a lost race are
 *  never swept — each is a few KB of prompt text under outRoot, and sweeping them needs no
 *  correctness fix, only disk hygiene; add a startup sweep if that ever measurably matters. */
export function publishPluginAtomic(outRoot: string, hash: string, files: readonly PluginFile[]): string {
  const finalDir = join(outRoot, hash);
  if (existsSync(finalDir)) return finalDir;
  mkdirSync(outRoot, { recursive: true });
  const stageDir = mkdtempSync(join(outRoot, ".stage-"));
  try {
    writePluginFiles(stageDir, files);
    renameSync(stageDir, finalDir);
  } catch (e) {
    if (existsSync(finalDir)) {
      // Another process published the same content-addressed hash first — success, not a
      // failure; our own stage attempt is now redundant.
      rmSync(stageDir, { recursive: true, force: true });
      return finalDir;
    }
    rmSync(stageDir, { recursive: true, force: true });
    throw e;
  }
  return finalDir;
}

export interface RenderedSkillsPlugin {
  /** Absolute path to the published, content-hash-named plugin directory — the exact value a
   *  caller passes to `--plugin-dir`. */
  dir: string;
  hash: string;
}

/** The engine-startup entry point: read docs/security.md, extract+render the v1 skills, publish
 *  atomically under `outRoot`, return the versioned directory a session's `--plugin-dir` should
 *  point at. FAIL-CLOSED at startup — a missing docs/security.md, or a missing/duplicated
 *  marker, throws HERE, before any session ever dispatches (same "read eagerly, abort startup"
 *  posture as worker.ts's buildRenderPrompt / plan-review.ts's loadRolePromptTemplate). */
export function renderSkillsPlugin(opts: { securityMdPath: string; outRoot: string }): RenderedSkillsPlugin {
  if (!existsSync(opts.securityMdPath)) {
    throw new Error(`roles.skills.enabled requires ${opts.securityMdPath} to exist — refusing to start`);
  }
  const securityMd = readFileSync(opts.securityMdPath, "utf8");
  const files = buildSkillsPluginFiles(securityMd);
  const hash = hashPluginFiles(files);
  const dir = publishPluginAtomic(opts.outRoot, hash, files);
  return { dir, hash };
}

/** engine startup wiring: `roles.skills.enabled: false` (the default) -> undefined, so every
 *  claudeArgs()-producing caller stays byte-identical to pre-#639 argv (the AC's reverse test).
 *  `true` renders (or reuses) the plugin dir eagerly and fails startup closed on any marker
 *  problem — never a lazily-discovered failure mid-round. */
export function resolveSkillsPluginDir(cfg: { roles: { skills: { enabled: boolean } } }, cwd: string = process.cwd()): string | undefined {
  if (!cfg.roles.skills.enabled) return undefined;
  return renderSkillsPlugin({
    securityMdPath: join(cwd, "docs", "security.md"),
    outRoot: join(cwd, "data", "generated", "role-skills"),
  }).dir;
}

/** #639's injection policy table: which session kinds get `--plugin-dir` attached, pinned by
 *  name so the policy is one small pure function tests assert against directly rather than
 *  something inferred from call-site plumbing. A review-mode session (materialized, closed-MCP,
 *  gate② read-only tree) is the ONE exclusion — mirrors RoleRunner.run()'s existing
 *  `reviewMode ? {} : {worktree: name}` pattern for the same reason: a review session's tool
 *  profile and execution surface are hardcoded and closed by design (docs/security.md's "Review
 *  session mode" section), and a skill is one more thing for a session to invoke — out of scope
 *  for a session that must do nothing but read and judge. */
export type SkillsSessionKind = "worker-dispatch" | "worker-resume" | "worker-fix-entry" | "peripheral-role" | "review";

export function shouldInjectSkillsPlugin(kind: SkillsSessionKind): boolean {
  return kind !== "review";
}
