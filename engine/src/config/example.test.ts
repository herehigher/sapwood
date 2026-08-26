// #984: sapwood.config.example.yaml is the ONLY reference a fresh operator gets (init copies it
// verbatim) — these tests are the cross-artifact oracle that keeps it complete and in sync with
// the schema, per engine/prompts/doctrine-core.md's PROSE-PIN rule (doc-content test partition):
// an oracle comparing two artifacts, never a hash snapshot or a single-file prose pin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { ConfigSchema, engineAgentEmptyCiRequiredChecksError, parseConfig } from "./config.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const examplePath = join(repoRoot, "sapwood.config.example.yaml");
const exampleText = readFileSync(examplePath, "utf8");
const withBoard = (text: string) => text.replace("owner: CHANGEME", "owner: acme").replace("repo: CHANGEME", "repo: widgets");

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
  const def = (s as unknown as { _def: { typeName: string; shape?: () => Record<string, z.ZodTypeAny>; type?: z.ZodTypeAny } })._def;
  if (def.typeName === "ZodObject" && def.shape) {
    const shape = def.shape();
    for (const key of Object.keys(shape)) collectLeafPaths(shape[key]!, [...prefix, key], out);
    return;
  }
  if (def.typeName === "ZodArray" && def.type) {
    const element = unwrapSchema(def.type);
    const elementTypeName = (element as unknown as { _def: { typeName: string } })._def.typeName;
    if (elementTypeName === "ZodObject") {
      // An array of OBJECTS (ci.requiredChecks: {name, app}[]) has structure past the array
      // itself — recurse into the element so e.g. `ci.requiredChecks[].app` (config.ts:360,
      // default "github-actions") is found too. `[]` folds onto the array's own key with no
      // separating dot (joinPath below mirrors this), so the leaf reads `ci.requiredChecks[].app`
      // rather than `ci.requiredChecks.[].app`. An array of primitives/enums (e.g.
      // reviewer.trustedReviewers, escalation.instructionPaths) has no further structure and
      // falls through to the plain leaf below, unchanged.
      const last = prefix[prefix.length - 1];
      const arrayPrefix = last === undefined ? prefix : [...prefix.slice(0, -1), `${last}[]`];
      collectLeafPaths(element, arrayPrefix, out);
      return;
    }
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
    for (let i = 1; i <= parts.length; i++) {
      const ancestor = parts.slice(0, i).join(".");
      all.add(ancestor);
      // An array-of-objects key is legitimately mentioned in the YAML BOTH as its own plain
      // container line (`requiredChecks:`, before any `- ` item differentiates it) and, once an
      // item opens an element, as `requiredChecks[]` (collectLeafPaths' own convention above) —
      // accept either spelling as a valid (reverse-check) container path.
      if (ancestor.endsWith("[]")) all.add(ancestor.slice(0, -2));
    }
  }
  return { leaves, all };
}

// ---- sapwood.config.example.yaml key extraction (live or commented) ----
//
// Convention this file is written to (and this parser relies on): a commented key line is
// `<real leading spaces>#<one separator space><key>: ...` — extra spaces after that one
// separator encode nesting depth exactly like live YAML's own 2-space indent, so a commented
// block's structure is recoverable without a YAML parser (which would just discard comments). A
// line that doesn't look like a bare `identifier:` at its own indent, OR a `- ` list item — prose,
// a wrapped array continuation, a nested explanatory comment starting with a second `#` — is not a
// key line and is ignored; it neither opens nor closes a nesting level.
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*):/;

/** Joins stack keys into a dotted path, EXCEPT a `"[]"` element-marker (pushed for an array-of-
 *  object's list item — see the `content.startsWith("-")` branch below) folds onto the PRECEDING
 *  key with no separating dot, matching `collectLeafPaths`' own `${arrayKey}[]` convention above
 *  — so `ci`, `requiredChecks`, `[]`, `app` joins as `ci.requiredChecks[].app`, never
 *  `ci.requiredChecks.[].app`. */
function joinPath(keys: string[]): string {
  let out = "";
  for (const key of keys) out += key === "[]" ? "[]" : out.length ? `.${key}` : key;
  return out;
}

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
    if (content.startsWith("#")) continue; // nested explanatory prose, never a key line

    if (content.startsWith("-")) {
      // A list item under an array-of-objects key (`ci.requiredChecks`'s `- name: test` example)
      // opens ONE array-element level at its own indent (`requiredChecks[]`); an inline
      // `key: value` right after the dash (`- name: test`) is a CHILD of that element, one level
      // deeper still — same rule as any other nesting — so a later sibling line at that child's
      // indent (`app: ...`, two spaces deeper than the dash) attaches under the SAME element
      // instead of reopening a new one.
      while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
      found.add(joinPath([...stack.map((s) => s.key), "[]"]));
      stack.push({ indent, key: "[]" });
      const rest = content.slice(1).trimStart();
      const m = KEY_LINE.exec(rest);
      if (m) {
        found.add(joinPath([...stack.map((s) => s.key), m[1]!]));
        stack.push({ indent: indent + 2, key: m[1]! });
      }
      continue;
    }

    const m = KEY_LINE.exec(content);
    if (!m) continue;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    found.add(joinPath([...stack.map((s) => s.key), m[1]!]));
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
