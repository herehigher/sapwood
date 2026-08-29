// Property-based test on top of guard.fuzz.test.ts's differential corpus (a fixed command
// list vs. a static guard.py verdict table). That corpus is powerful for catching
// tokenizer divergence on KNOWN inputs, but every case in it was hand-picked or generated
// once and frozen — it can't discover a path-normalisation or wrapper-shape bypass nobody
// thought to write down. fast-check instead draws arbitrary directory prefixes, casings, and
// write vectors on every run and shrinks any counterexample to a minimal failing path, so it
// probes the SPACE of inputs around the invariants docs/security.md "Human-merge-only paths"
// documents, not just the point-samples the corpus fixed in place. No new guard behaviour is
// asserted here — every property restates something guard.ts's own comments already claim.
//
// ponytail: does not cover Bash tokenizer edge cases (quoting, escaping, command
// substitution) around a write path — guard.fuzz.test.ts compares only opaque-construct and
// gh-overreach verdicts against the guard.py oracle, so a quoted write-path regression is
// caught by neither file today. Also
// does not cover the `.github/CODEOWNERS` rule (guard.ts does not path-deny it; it's a
// process-level control per docs/security.md), symlink aliasing (a documented residual, not
// something any lexical path check closes), or gh-overreach/opaque-construct categories
// (guard.fuzz.test.ts's corpus already exercises those against the shared oracle).
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { guardDecision } from "./guard.js";

const CWD = "/repo";

// ── path-segment generator ───────────────────────────────────────────────────
// Deliberately excludes "." and "/" so a generated segment can never collapse a "..", eat
// into the fixed suffix below, or otherwise change which rule the assembled path is meant to
// exercise — the property is about arbitrary PREFIXES around a known protected suffix, not
// about path-normalisation edge cases (those are normalizePath's own concern, unit-tested
// directly in guard.test.ts).
// "-" is excluded for now: the write-command scan treats any "-"-leading argument as a flag
// rather than a path, so a leading-dash segment is a known guard gap (tracked as its own
// security issue, fixed in guard.ts, which this file must not edit). Excluding it keeps the
// gap from being frozen into these properties as if it were intended; once the guard closes
// it, "-" joins the alphabet and the properties cover that shape too.
const SEGMENT_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split("");
const segmentArb = () => fc.array(fc.constantFrom(...SEGMENT_CHARS), { minLength: 1, maxLength: 10 }).map((chars) => chars.join(""));
const prefixArb = () => fc.array(segmentArb(), { minLength: 0, maxLength: 4 });

// Basenames the source-file suffix rule matches regardless of prefix (see FIXED_PROTECTED_SUFFIXES).
const PROTECTED_TS_BASENAMES = new Set(["guard", "guard-hook", "reviewer", "merge-driver"]);

const joinRel = (prefix: string[], suffix: string): string => (prefix.length ? `${prefix.join("/")}/${suffix}` : suffix);

// ── the write-path universe. docs/security.md "Human-merge-only paths" is the list this mirrors,
// plus the `.sapwood/` runtime directory guard.ts fences on its own (runtime state, not source —
// but the same write-path rule). Families the docs write as globs are GENERATED, not sampled, so
// a regression that keeps one example blocked while freeing its siblings still fails here.
// `.claude/settings*.json` is the exception: the guard matches exactly two names today and the
// doc/guard disagreement is tracked separately, so only those two are asserted. guard.ts does not
// export one list combining all its path rules (only the narrower source-file PROTECTED_SUFFIXES
// and the SAPWOOD_ROOT_SEGMENT constant), so the fixed part is kept here. ────────────────────────
const FIXED_PROTECTED_SUFFIXES = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  "sapwood.config.yaml",
  "sapwood.config.yml",
  "sapwood.config.json",
  "sapwood.config.example.yaml",
  "sapwood.config.example.yml",
  "sapwood.config.example.json",
  "engine/src/guard/guard.ts",
  "engine/src/guard/guard-hook.ts",
  "engine/src/roles/reviewer.ts",
  "engine/src/roles/merge-driver.ts",
  "engine/dist/guard/guard.js",
  "engine/dist/guard/guard-hook.js",
  "engine/dist/roles/reviewer.js",
  "engine/dist/roles/merge-driver.js",
];
// `.github/workflows/**`: any depth, any extension (the rule is on the directory, not on YAML).
const workflowsPathArb = () =>
  fc
    .tuple(fc.array(segmentArb(), { minLength: 0, maxLength: 2 }), segmentArb(), fc.constantFrom(".yml", ".yaml", ".md", ""))
    .map(([dirs, name, ext]) => [".github/workflows", ...dirs, `${name}${ext}`].join("/"));
// `.sapwood/**`: the whole runtime directory, any depth.
const sapwoodPathArb = () =>
  fc
    .tuple(fc.array(segmentArb(), { minLength: 0, maxLength: 2 }), segmentArb())
    .map(([dirs, name]) => [".sapwood", ...dirs, name].join("/"));
const protectedSuffixArb = () => fc.oneof(fc.constantFrom(...FIXED_PROTECTED_SUFFIXES), workflowsPathArb(), sapwoodPathArb());

// The families guard.ts's own comments call out as matched case-insensitively (macOS/APFS
// default, deliberate fail-closed stance) — `.github/workflows/**` and `.claude/settings*.json`
// are NOT among them because their regexes carry no `i` flag.
const caseInsensitiveSuffixArb = () =>
  fc.oneof(
    fc.constantFrom(
      "sapwood.config.yaml",
      "sapwood.config.yml",
      "sapwood.config.json",
      "sapwood.config.example.yaml",
      "sapwood.config.example.yml",
      "sapwood.config.example.json",
    ),
    sapwoodPathArb(),
  );

const caseVariantArb = (s: string) =>
  fc.array(fc.boolean(), { minLength: s.length, maxLength: s.length }).map((bits) =>
    s
      .split("")
      .map((c, i) => (bits[i] ? c.toUpperCase() : c.toLowerCase()))
      .join(""),
  );

// ── write vectors that reach a path outside the Write/Edit tools (mirrors
// checkBashWritePath's redirection + WRITE_CMDS handling) ────────────────────
const BASH_WRITE_TEMPLATES: Array<(p: string) => string> = [
  (p) => `> ${p}`,
  (p) => `echo x >> ${p}`,
  (p) => `cat foo > ${p}`,
  (p) => `tee ${p}`,
  (p) => `sed -i s/a/b/ ${p}`,
  (p) => `dd if=/dev/zero of=${p}`,
  (p) => `cp /tmp/src ${p}`,
  (p) => `install -m 644 /tmp/src ${p}`,
  (p) => `mv ${p} /tmp/dst`,
  (p) => `rm ${p}`,
  (p) => `rm -rf ${p}`,
  (p) => `touch ${p}`,
  (p) => `git rm ${p}`,
  (p) => `git mv ${p} /tmp/dst`,
  (p) => `git restore -- ${p}`,
  (p) => `git checkout HEAD -- ${p}`,
];

test("guard.property: any directory prefix + a human-merge-only path suffix is blocked for Write/Edit", () => {
  fc.assert(
    fc.property(
      prefixArb(),
      protectedSuffixArb(),
      fc.constantFrom("Write", "Edit"),
      fc.boolean(), // resolve as an absolute path under cwd, vs. a bare relative one
      fc.boolean(), // relative form gets a "./" prefix
      (prefix, suffix, tool, absolute, dotSlash) => {
        const rel = joinRel(prefix, suffix);
        const filePath = absolute ? `/repo/${rel}` : dotSlash ? `./${rel}` : rel;
        const decision = guardDecision(tool, { file_path: filePath }, CWD);
        assert.equal(decision.allow, false, `expected BLOCK for ${tool} ${filePath}`);
        assert.match(decision.reason, /write-path/i, `expected write-path category, got: ${decision.reason}`);
      },
    ),
    { numRuns: 200 },
  );
});

test("guard.property: the same human-merge-only path reached through a Bash write vector is blocked", () => {
  fc.assert(
    fc.property(prefixArb(), protectedSuffixArb(), fc.constantFrom(...BASH_WRITE_TEMPLATES), (prefix, suffix, template) => {
      const command = template(joinRel(prefix, suffix));
      const decision = guardDecision("Bash", { command }, CWD);
      assert.equal(decision.allow, false, `expected BLOCK for: ${command}`);
      assert.match(decision.reason, /write-path/i, `expected write-path category, got: ${decision.reason}`);
    }),
    { numRuns: 200 },
  );
});

test("guard.property: .sapwood/** and sapwood.config* block regardless of letter casing", () => {
  fc.assert(
    fc.property(
      prefixArb(),
      caseInsensitiveSuffixArb().chain(caseVariantArb),
      fc.constantFrom("Write", "Edit"),
      (prefix, casedSuffix, tool) => {
        const filePath = joinRel(prefix, casedSuffix);
        const decision = guardDecision(tool, { file_path: filePath }, CWD);
        assert.equal(decision.allow, false, `expected BLOCK for ${tool} ${filePath}`);
        assert.match(decision.reason, /write-path/i, `expected write-path category, got: ${decision.reason}`);
      },
    ),
    { numRuns: 200 },
  );
});

test("guard.property: a path outside every protected prefix/basename is not blocked by the write-path rule", () => {
  fc.assert(
    fc.property(
      fc.array(segmentArb(), { minLength: 0, maxLength: 3 }),
      segmentArb().filter((name) => !PROTECTED_TS_BASENAMES.has(name)),
      fc.constantFrom("Write", "Edit"),
      (subdirs, filename, tool) => {
        // Segments carry no "." so ".github", ".claude", ".sapwood" and "sapwood.config*" can't
        // appear, and a ".ts" name can't hit the compiled "engine/dist/**/*.js" rules. The one
        // remaining collision is a ".ts" basename the source-file suffix match recognises under
        // any prefix ("src/engine/src/guard/guard.ts" IS blocked, correctly) — hence the filter.
        const rel = ["src", ...subdirs, `${filename}.ts`].join("/");
        const decision = guardDecision(tool, { file_path: rel }, CWD);
        // Write/Edit/MultiEdit/NotebookEdit run through exactly one rule in guardDecision
        // (checkWritePath) — nothing else can fire for these tools, so a blanket ALLOW here
        // is equivalent to "not blocked by the write-path rule", not an overreaching assertion.
        assert.equal(decision.allow, true, `expected ALLOW for ${tool} ${rel}: ${decision.reason}`);
      },
    ),
    { numRuns: 200 },
  );
});
