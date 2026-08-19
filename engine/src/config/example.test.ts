// #984: sapwood.config.example.yaml is the ONLY reference a fresh operator gets (init copies it
// verbatim) — these tests are the cross-artifact oracle that keeps it complete and in sync with
// the schema, per docs/REVIEW-DOCTRINE.md's doc-content test partition (an oracle comparing two
// artifacts, never a hash snapshot or a single-file prose pin).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { ConfigSchema, configHash, engineAgentEmptyCiRequiredChecksError, parseConfig } from "./config.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const examplePath = join(repoRoot, "sapwood.config.example.yaml");
const exampleText = readFileSync(examplePath, "utf8");
const withBoard = (text: string) => text.replace("owner: CHANGEME", "owner: acme").replace("repo: CHANGEME", "repo: widgets");

// The pre-#984 example (77 lines, board/lanes/worker/cost/reviewer.mode/merge.mode/language/
// envFailure/ci-guidance/escalation only) — kept here ONLY as the "before" half of the
// effective-config equivalence oracle below, never as a style reference. #984 must add every
// missing schema key as a COMMENT without moving a single live value.
const PRE_984_EXAMPLE = `# Sapwood configuration example for the repository you want Sapwood to operate on.
# Copy this file to sapwood.config.yaml, then replace the three board placeholders. The comments
# state the documented defaults; see docs/configuration.md for the complete reference.

board:
  owner: CHANGEME # required: your GitHub user or organization
  repo: CHANGEME # required: your repository name
  projectNumber: 1 # required: your ProjectV2 board number
  # ownerKind: user # default: auto-detected by \`sapwood init\` when omitted
  # statusField: Status # default: Status
  # status: # defaults: Todo, Ready, In Progress, Done
  #   backlog: Todo
  #   ready: Ready
  #   inProgress: In Progress
  #   done: Done

# goal:
#   file: docs/GOAL.md # default: docs/GOAL.md — the project's north-star goal file (\`sapwood init\`
#                        # scaffolds it from the shipped template when missing)

lanes:
  max: 3 # default: 3 concurrent workers
  roundDispatchCap: 2 # default: 2 new dispatches per round/tick
  reserveCap: 1 # default: 1 (accepted but not yet wired)
  prFixCap: 4 # default: 4 fix-leg rounds
  frictionMin: 0 # default: 0 (accepted but not yet wired)
  gatedReentryCap: 2 # default: 2

worker:
  model: opus # default: opus
  effort: high # default: high
  fallbackModel: sonnet # default: sonnet; set "none" to fail rather than downgrade
  timeoutSec: 3600 # default: 3600 seconds
  budgetUsdSoft: 10 # default: 10 USD soft per-worker budget
  maxResumes: 2 # default: 2
  heartbeatStaleSecs: 180 # default: 180 seconds

cost:
  roundBudgetUsd: 30 # default: 30 USD
  dailyBudgetUsd: 100 # default: 100 USD

reviewer:
  mode: engine-agent # default: engine-agent

# ci.requiredChecks is deliberately NOT pre-filled: sapwood cannot know your CI check's name, and a
# plausible wrong guess would queue every PR forever. With reviewer.mode engine-agent, \`sapwood run\`
# refuses to start until you name at least one check-run of your CI (\`sapwood validate\` tells you
# the same). Use the exact check-run name GitHub shows on a PR (a workflow job name, e.g. "test").
# ci:
#   requiredChecks:
#     - name: test

merge:
  # The schema default is conductor-merge (L3). \`sapwood init\` deliberately pins this L2
  # starter default so a new target repository produces a PR and stops for human merge authority.
  mode: produce-pr-and-stop

# These are the documented defaults. Uncomment to override them.
# language: # default: en for every surface — see docs/configuration.md's "language" section
#   codeComments: en # BCP-47-ish tag (e.g. ja, zh-Hans, pt-BR); passed through opaquely
#   issuesAndPrs: en
#   docs: en
# envFailure:
#   llmPatterns: [rate_limit_error, "rate limit exceeded", "usage limit reached",
#                 "credit balance is too low", insufficient_quota, overloaded_error,
#                 "429 too many requests", "hit your (?:session|weekly|5-hour) limit"]
#   forgePatterns: ["could not resolve host", "connection refused", "network is unreachable",
#                   "temporary failure in name resolution", "bad gateway", "gateway timeout",
#                   "service unavailable", "bad credentials", "401 unauthorized", "gh auth login",
#                   "SAML enforcement"]
#   parkEscalateAfterSec: 3600 # default: 3600 seconds
#   probeBackoffBaseSec: 30 # default: 30 seconds
#   probeBackoffMaxSec: 1800 # default: 1800 seconds
#   probeModel: haiku # default: haiku
#   probeTimeoutSec: 30 # default: 30 seconds
#   probeMaxBudgetUsd: 0.05 # default: 0.05 USD

# escalation:
#   # Defaults are canonical paths relative to YOUR target repository. \`engine/prompts/**\`
#   # matters only when that target repository is Sapwood's engine source tree; it is otherwise
#   # inert self-hosting coverage, not a path your repository is expected to contain.
#   instructionPaths: [CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md, .claude/rules/**, AGENTS.md,
#                      engine/prompts/**, engine/src/review/instruction-path-escalation.ts,
#                      engine/src/config/config.ts, sapwood.config.example.yaml, docs/security.md, engine/src/roles/skills-plugin.ts,
#                      engine/src/forge/labels.ts]
`;

// ---- schema key enumeration (mechanical — walks the Zod schema itself, not a parsed instance,
// so a purely-optional no-default field like stop.afterIssuesMerged is found too) ----

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = (schema as unknown as { _def: { typeName: string; schema?: z.ZodTypeAny; innerType?: z.ZodTypeAny } })._def;
  if (def.typeName === "ZodEffects" && def.schema) return unwrapSchema(def.schema);
  if ((def.typeName === "ZodOptional" || def.typeName === "ZodDefault") && def.innerType) return unwrapSchema(def.innerType);
  return schema;
}

function collectLeafPaths(schema: z.ZodTypeAny, prefix: string[], out: Set<string>): void {
  const s = unwrapSchema(schema);
  const def = (s as unknown as { _def: { typeName: string; shape?: () => Record<string, z.ZodTypeAny> } })._def;
  if (def.typeName === "ZodObject" && def.shape) {
    const shape = def.shape();
    for (const key of Object.keys(shape)) collectLeafPaths(shape[key]!, [...prefix, key], out);
    return;
  }
  out.add(prefix.join("."));
}

/** Every schema key path (leaves), plus every ancestor/container path a leaf implies — e.g. the
 *  leaf `reviewer.agent.model` also contributes the container paths `reviewer` and
 *  `reviewer.agent`. `all` is the accept-set for the reverse (no-extraneous-key) check below;
 *  `leaves` is the require-set for the forward (every-key-present) check. */
function schemaKeyPaths(): { leaves: Set<string>; all: Set<string> } {
  const leaves = new Set<string>();
  collectLeafPaths(ConfigSchema, [], leaves);
  const all = new Set<string>();
  for (const leaf of leaves) {
    const parts = leaf.split(".");
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join("."));
  }
  return { leaves, all };
}

// ---- sapwood.config.example.yaml key extraction (live or commented) ----
//
// Convention this file is written to (and this parser relies on): a commented key line is
// `<real leading spaces>#<one separator space><key>: ...` — extra spaces after that one
// separator encode nesting depth exactly like live YAML's own 2-space indent, so a commented
// block's structure is recoverable without a YAML parser (which would just discard comments). A
// line that doesn't look like a bare `identifier:` at its own indent — prose, a list item, a
// wrapped array continuation, a nested explanatory comment starting with a second `#` — is not a
// key line and is ignored; it neither opens nor closes a nesting level.
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*):/;

function exampleKeyPaths(text: string): Set<string> {
  const stack: { indent: number; key: string }[] = [];
  const found = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim().length === 0) continue;
    const hashIndex = line.indexOf("#");
    const beforeHash = hashIndex === -1 ? line : line.slice(0, hashIndex);
    let indent: number;
    let content: string;
    if (beforeHash.trim().length > 0) {
      // Live YAML line — an inline `# comment` (if any) trails real content.
      indent = line.length - line.trimStart().length;
      content = beforeHash.trim();
    } else {
      // Pure comment line. One space right after `#` is the conventional separator; any
      // FURTHER leading space on the remainder is this line's own extra nesting depth.
      const spacesBeforeHash = line.length - line.trimStart().length;
      const afterHash = line.slice(spacesBeforeHash + 1);
      const spacesAfterHash = afterHash.length - afterHash.trimStart().length;
      indent = spacesBeforeHash + Math.max(0, spacesAfterHash - 1);
      content = afterHash.trimStart();
    }
    if (content.startsWith("-") || content.startsWith("#")) continue; // list item / nested prose
    const m = KEY_LINE.exec(content);
    if (!m) continue;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    found.add([...stack.map((s) => s.key), m[1]].join("."));
    stack.push({ indent, key: m[1]! });
  }
  return found;
}

test("AC1: every schema key appears in sapwood.config.example.yaml, live or commented, at its current default", () => {
  const { leaves } = schemaKeyPaths();
  const mentioned = exampleKeyPaths(exampleText);
  const missing = [...leaves].filter((k) => !mentioned.has(k)).sort();
  assert.deepEqual(missing, [], `schema keys missing from sapwood.config.example.yaml:\n${missing.join("\n")}`);
});

test("AC1 (reverse): every key mentioned in sapwood.config.example.yaml exists in the schema — no stale/invented key", () => {
  const { all } = schemaKeyPaths();
  const mentioned = exampleKeyPaths(exampleText);
  const extra = [...mentioned].filter((k) => !all.has(k)).sort();
  assert.deepEqual(extra, [], `sapwood.config.example.yaml mentions keys the schema does not have:\n${extra.join("\n")}`);
});

test("AC2: no retired role key name and no dead coverage/optimize key survives in the example, and neither is a live schema key", () => {
  // The example must never mention a name a fresh operator could copy into their own config
  // and have it silently do nothing (or get rejected with no forwarding hint).
  for (const [pattern, label] of [
    [/planReviewer\b/, "planReviewer"],
    [/planDrafter\b/, "planDrafter"],
    [/\bminPercent\b/, "minPercent"],
    [/coverage:/, "coverage:"],
    [/\boptimize\b/, "optimize"],
  ] as const) {
    assert.doesNotMatch(exampleText, pattern, `sapwood.config.example.yaml still mentions ${label}`);
  }
  // `coverage`/`optimize` are gone from the schema entirely (strict() rejects them as unknown
  // top-level keys, same as any typo) — verified against the schema itself, not a source-text
  // grep: engine/src/config/config.ts:2099-2102's RENAMED_ROLE_KEYS table legitimately still
  // references the STRINGS "planReviewer"/"planDrafter" — that table is what turns a copy-pasted
  // old role name into a rename-pointing error (#413, pinned by config.test.ts) rather than a
  // generic unrecognized-key rejection; a bare literal-text ban would demand deleting it.
  const { all } = schemaKeyPaths();
  for (const dead of ["coverage", "coverage.minPercent", "optimize", "optimize.recur"]) {
    assert.ok(!all.has(dead), `${dead} is still a schema key`);
  }
  assert.throws(() => parseConfig(withBoard(`board: { owner: CHANGEME, repo: CHANGEME, projectNumber: 1 }\ncoverage: { minPercent: 0 }`)));
  assert.throws(() => parseConfig(withBoard(`board: { owner: CHANGEME, repo: CHANGEME, projectNumber: 1 }\noptimize: { recur: false }`)));
});

test("AC3: sapwood.config.example.yaml still refuses per #801 (engine-agent + empty ci.requiredChecks), and says why + what to configure", () => {
  const cfg = parseConfig(withBoard(exampleText));
  assert.ok(engineAgentEmptyCiRequiredChecksError(cfg), "expected the #801 refusal to still fire on the shipped example");
  assert.match(exampleText, /ci\.requiredChecks is deliberately NOT pre-filled/);
  assert.match(exampleText, /requiredChecks:\s*\n#\s*- name: test/);
});

test("becoming a complete reference does not change the example's EFFECTIVE config: parseConfig(new text) equals parseConfig(pre-#984 text)", () => {
  const before = configHash(parseConfig(withBoard(PRE_984_EXAMPLE)));
  const after = configHash(parseConfig(withBoard(exampleText)));
  assert.equal(
    after,
    before,
    "sapwood.config.example.yaml's resolved config changed — #984 may only ADD commented keys, never move a live value",
  );
});
