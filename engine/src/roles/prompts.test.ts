// prompts.test.ts: snapshot tests for shipped role prompt templates under engine/prompts/.
// Any future edit, intentional or not, must update the matching hash alongside it. Content
// assertions below pin issue-specific language and structural output contracts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { defaultPoolPromptPath, defaultPoPromptPath } from "../loop/align.js";
import { defaultPoDecomposePromptPath } from "../loop/decompose.js";
import { defaultHarvestPromptPath } from "../loop/harvest.js";
import { defaultDoctrineTemplatePath } from "../loop/init.js";
import { PROXY_ROLE_TOOL_MATRIX } from "../proxy/access.js";
import { defaultRetroPromptPath } from "../retro/retro.js";
import { defaultEngineReviewerPromptPath } from "../review/engine-agent.js";
import { defaultArchitectPromptPath } from "./architect.js";
import { defaultPlanConfirmPromptPath, defaultPlanDrafterPromptPath, defaultPlanReviewerPromptPath } from "./plan-review.js";
import { defaultFixPromptPath, defaultPromptPath } from "./worker.js";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function readPrompt(path: string): string {
  return readFileSync(path, "utf8");
}

// ── Snapshot hashes — update deliberately, alongside a reviewed prompt edit, never casually ───

const SNAPSHOT_HASHES: Record<string, string> = {
  // #444 (F35): intentional edit — the digest is no longer called "authoritative for current open
  // issues" (it never was: it was milestone-scoped, so the issues a session duplicated were
  // exactly the ones it could not see). The prompt now names the digest's real scope, explains
  // the out-of-round annotations align.ts renders, and mandates `mcp__forge__search_issues`
  // before filing where the proxy is attached. Prior edit: #410 (WebSearch/WebFetch usage +
  // abstention wording, and the reworded "stay inside your scope" bullet).
  // #529 F1 (gate② round 1): line 9 carried the exact same categorical denial as the six roles
  // below — the ONLY reason it didn't trip the AC-2 test was that `namesTheGrantedTools` is
  // file-scoped and line 69 names `mcp__forge__search_issues` sixty lines later. Fixed so the
  // escape hatch below has no live user left in the repo, consistent with align mode's own
  // dedup-step instruction (still at what's now ~line 72), not merely permissive against it.
  // #529 D2 (gate② round 2): the fallback clause's "no GitHub access at all" was itself false —
  // po-align/po-triage hold a default WebFetch grant, which reaches github.com. Rescoped to
  // "no issue-API access at all".
  "po.md": "959c3f3dd9ac441aa976d08a7faba544a621d15eb5c530ed751b9ea58c78b6f3",
  // #529: the categorical "no tool call of yours reaches GitHub" denial is replaced with the
  // conditional form — true whether or not the forge MCP proxy is attached to this session.
  // #529 D1 (gate② round 2): the fallback clause's "no GitHub access at all" was itself false —
  // architect holds a default WebFetch grant, which reaches github.com. Rescoped to "no
  // issue-API access at all".
  "architect.md": "90e4964fed79e39a26832c9cd04ac4e8ee45d05e1545946688186417a85cd2cb",
  // #457 (F36): intentional edits — execution-class ACs are plan noise (CI already enforces
  // ci.requiredChecks unconditionally): plan-reviewer flags-and-strips them, the confirm pass
  // invalidates legacy plans carrying them, drafter/decompose never author them.
  // #529: same categorical→conditional GitHub-access fix as architect.md.
  "plan-reviewer.md": "43a042fa33300b8421d3a98e6c253c3ac20a1b678d5b312875dc8f26673d691b",
  "plan-reviewer-confirm.md": "895ae8b6dace1417d576e8398e9918921e78d28b96a4d9a7c07c245e7071ad2d",
  "plan-drafter.md": "0d808e7075e91c91fa070aa3c68aa711a9de950a2cbb93d64ce3e0c664bfb188",
  "harvest.md": "82312e3ac79e42e008a9d7477d4b9e601623a9ebb1e5a4fe306e8b3f266d109d",
  // #453 (design #402 R5): intentional edit — the digest's new finding-class tendency table is
  // pointed at, with the design-source rule and the stated blind spot. The FIRST deliberate
  // change to this file since #235 pinned it as "already code-aware, do not touch"; that ruling
  // was about tool scope, not about the role's analysis inputs, so it is not re-litigated here.
  "retro.md": "266dfa04d6a36405e911eb6d0db60f929f5400d99aef8d72d1f388306b8d7f0e",
  // #529: same categorical→conditional GitHub-access fix as architect.md.
  "po-pool.md": "13e4b27cad513e06bd0b99bed6dce612600d477e8b2a654fffa81649f2672c18",
  "po-decompose.md": "3289b0f37585b84fdce67319f9ae4b2e82c8873b13b2a292adef25b1bca79ae2",
};

test("prompt snapshot: po.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultPoPromptPath())), SNAPSHOT_HASHES["po.md"]);
});

test("prompt snapshot: architect.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultArchitectPromptPath())), SNAPSHOT_HASHES["architect.md"]);
});

test("prompt snapshot: plan-reviewer.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultPlanReviewerPromptPath())), SNAPSHOT_HASHES["plan-reviewer.md"]);
});

test("prompt snapshot: plan-reviewer-confirm.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultPlanConfirmPromptPath())), SNAPSHOT_HASHES["plan-reviewer-confirm.md"]);
});

test("prompt snapshot: plan-drafter.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultPlanDrafterPromptPath())), SNAPSHOT_HASHES["plan-drafter.md"]);
});

test("prompt snapshot: harvest.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultHarvestPromptPath())), SNAPSHOT_HASHES["harvest.md"]);
});

test("prompt snapshot: retro.md hash matches the pinned revision (#235's tool-scope freeze still holds — the only edit since is #453's tendency-table section)", () => {
  assert.equal(sha256(readPrompt(defaultRetroPromptPath())), SNAPSHOT_HASHES["retro.md"]);
  // #235 AC item 3 was about retro's TOOL SCOPE, and that half is still pinned byte-wise below:
  // the prompt gained no tool grant, no `gh` instruction, and no direct-write path.
  const body = readPrompt(defaultRetroPromptPath());
  for (const forbidden of ["gh pr view", "gh pr list", "gh issue view", "gh issue list", "gh pr create"]) {
    assert.ok(!body.includes(forbidden), `retro.md must not instruct ${forbidden}`);
  }
});

test("prompt snapshot: po-pool.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultPoolPromptPath())), SNAPSHOT_HASHES["po-pool.md"]);
});

test("prompt snapshot: po-decompose.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultPoDecomposePromptPath())), SNAPSHOT_HASHES["po-decompose.md"]);
});

// ── #529 (AC-2): declared-session-contract drift — a role's prompt must never assert,
// categorically, that no tool of the session reaches GitHub while access.ts's own
// PROXY_ROLE_TOOL_MATRIX grants that role a non-empty set of forge MCP tools. Driven off the
// matrix itself (not a hand-copied list of role names) so that adding a role to the matrix
// without touching its prompt fails THIS test, not just a live dogfood count months later. ──

// role id -> shipped prompt file(s) that role's session is rendered from. Every key in
// PROXY_ROLE_TOOL_MATRIX must appear here (checked below) — an unmapped role is a test
// FAILURE, not a silently-skipped role, exactly like the matrix's own deny-by-default stance
// (access.ts's `?? []`) refuses an implicit pass.
const ROLE_PROMPT_PATHS: Readonly<Record<string, readonly string[]>> = {
  "po-pool": [defaultPoolPromptPath()],
  // po-align and po-triage are two `{{po.mode}}` branches of the SAME shipped file (po.md) —
  // see align.ts. Both map to it.
  "po-align": [defaultPoPromptPath()],
  "po-triage": [defaultPoPromptPath()],
  harvest: [defaultHarvestPromptPath()],
  architect: [defaultArchitectPromptPath()],
  "plan-reviewer": [defaultPlanReviewerPromptPath()],
  "plan-drafter": [defaultPlanDrafterPromptPath()],
  "plan-reviewer-confirm": [defaultPlanConfirmPromptPath()],
  retro: [defaultRetroPromptPath()],
  // worker's PR_TOOLS grant is consumed by both the main dispatch leg (worker.md) and the
  // fix-loop leg (fix.md) — both mint with role: "worker" (worker.ts).
  worker: [defaultPromptPath(), defaultFixPromptPath()],
};

// gate② round 2 (F1-D1/D2/D3 on PR #532): architect and po-align/po-triage ALSO hold a default
// WebSearch/WebFetch grant — peripheral.ts's ARCHITECT_ALLOWED_TOOLS, align.ts's PO session
// wiring, config.ts's `webAccess.enabled` default true. `WebFetch` reaches github.com directly,
// so these three roles can never truthfully say "you have no GitHub access at all" even in the
// no-forge-tool branch of the #529 conditional. The other roles below genuinely have no web
// grant (config.ts's review-family exclusion), so the identical-looking sentence is true for
// them and must not be flagged.
const ROLES_WITH_DEFAULT_WEB_ACCESS: ReadonlySet<string> = new Set(["architect", "po-align", "po-triage"]);

test("#529 AC-2: no shipped role prompt asserts a categorical no-GitHub-access denial while its role holds a non-empty PROXY_ROLE_TOOL_MATRIX grant", () => {
  // Family 1 — the original #512-class bug: a negation ("no"/"never"/"nothing") within the
  // same clause as "reach(es)"/"touch(es)" GitHub, with no forge-tool mention anywhere in the
  // file to condition it (mitigated below by `namesTheGrantedTools` — this is what lets po.md's
  // WRITE-scoped "no tool call of yours reaches GitHub" pass: the same file's later dedup-step
  // paragraph names `mcp__forge__search_issues`, so a reader of the whole prompt learns the
  // true picture even though this one clause, read alone, oversells it).
  const REACHES_GITHUB_DENIAL = /\b(?:no|never|nothing)\b[^.]{0,80}\b(?:reach(?:es)?|touch(?:es)?)\b[^.]{0,80}\bGitHub\b/i;

  // Family 2 (gate② round 2, D3) — "you have no GitHub access at all" is the phrasing #529's OWN
  // conditional sentences actually use for their no-forge-tool branch, and it has no
  // reach(es)/touch(es) verb at all, so REACHES_GITHUB_DENIAL never even sees it — this is
  // exactly what let D1/D2 (architect.md, po.md claiming no GitHub access at all despite a
  // separate WebFetch grant) through gate② round 1. Deliberately NOT given the
  // `namesTheGrantedTools` escape hatch: by construction every one of these conditional
  // sentences names `mcp__forge__` in its own "if" branch, so a file-wide mention would
  // trivially exempt every prompt using this pattern — including a broken one (verified: this
  // is why widening the regex alone, without also narrowing this family's mitigation, would NOT
  // have caught D1/D2). The only thing that can legitimately excuse this phrase is the ROLE
  // itself genuinely holding no other GitHub-reaching tool — see ROLES_WITH_DEFAULT_WEB_ACCESS.
  // Requires "GitHub access" adjacent (not "GitHub ... access" with a gap) so this deliberately
  // does NOT match every file's "## You have no GitHub write access at all" heading — that
  // claim is correctly scoped to writes and true regardless of any web grant.
  const NO_GITHUB_ACCESS_DENIAL = /\b(?:no|never|nothing)\b[^.]{0,60}\bGitHub access\b/i;

  for (const [role, tools] of Object.entries(PROXY_ROLE_TOOL_MATRIX)) {
    if (tools.length === 0) continue; // nothing granted, nothing to be dishonest about

    const paths = ROLE_PROMPT_PATHS[role];
    assert.ok(
      paths !== undefined && paths.length > 0,
      `role "${role}" holds a non-empty forge proxy grant (${tools.join(", ")}) but has no ` +
        `entry in this test's ROLE_PROMPT_PATHS — add one, do not let it pass by omission`,
    );

    for (const path of paths) {
      const body = readPrompt(path);

      // A prompt may still legitimately talk about lacking WRITE access (e.g. "you never call
      // `gh`") — that's true regardless of the proxy. What it must not do is claim NO tool
      // reaches GitHub while never once naming the read-only tool family it actually may hold.
      const deniesReach = REACHES_GITHUB_DENIAL.test(body);
      const namesTheGrantedTools = body.includes("mcp__forge__");
      assert.ok(
        !deniesReach || namesTheGrantedTools,
        `${path} (role "${role}") reads as a categorical no-GitHub-access denial (matches ` +
          `${REACHES_GITHUB_DENIAL}) but never names an mcp__forge__ tool anywhere to condition ` +
          `that claim, even though the matrix grants this role ${tools.length} read-only tool(s): ${tools.join(", ")}`,
      );

      const deniesAccess = NO_GITHUB_ACCESS_DENIAL.test(body);
      assert.ok(
        !deniesAccess || !ROLES_WITH_DEFAULT_WEB_ACCESS.has(role),
        `${path} (role "${role}") asserts "no GitHub access at all" (matches ` +
          `${NO_GITHUB_ACCESS_DENIAL}) but this role also holds a default WebSearch/WebFetch ` +
          `grant, and WebFetch reaches github.com directly — the claim is false regardless of ` +
          `whether an mcp__forge__ tool is also mentioned nearby`,
      );
    }
  }

  // Known, accepted blind spot (gate② round 2, codex sol-high): the `namesTheGrantedTools`
  // escape hatch above is file-scoped text matching, not semantic — a contrived prompt could
  // name an `mcp__forge__` tool only to forbid its use ("never call mcp__forge__search_issues")
  // and still pass. Left as-is deliberately: closing it means building a prompt linter, and the
  // realistic failure mode this test exists to catch (a stale denial nobody meant to leave in)
  // doesn't produce that shape. Not fixed here; noted so the next reader doesn't mistake this
  // test for airtight.
});

test("shipped role prompts (#321): sentinel examples are plain text with no adjacent markdown fences", () => {
  const prompts: ReadonlyArray<readonly [name: string, path: string, sentinelCount: number]> = [
    ["plan-reviewer.md", defaultPlanReviewerPromptPath(), 2],
    ["plan-reviewer-confirm.md", defaultPlanConfirmPromptPath(), 2],
    ["plan-drafter.md", defaultPlanDrafterPromptPath(), 1],
    ["po.md", defaultPoPromptPath(), 4],
    ["po-pool.md", defaultPoolPromptPath(), 1],
    ["po-decompose.md", defaultPoDecomposePromptPath(), 2],
    ["architect.md", defaultArchitectPromptPath(), 2],
    ["harvest.md", defaultHarvestPromptPath(), 1],
  ];

  for (const [name, path, sentinelCount] of prompts) {
    const prompt = readPrompt(path);
    assert.match(prompt, /Emit the sentinel block as PLAIN TEXT: never wrap it in a markdown code fence\./, name);
    assert.equal(prompt.match(/^<<<SAPWOOD_RESULT>>>[ \t]*$/gm)?.length, sentinelCount, name);
    assert.equal(prompt.match(/^<<<END_SAPWOOD_RESULT>>>[ \t]*$/gm)?.length, sentinelCount, name);
    assert.doesNotMatch(prompt, /^ {0,3}(?:`{3,}|~{3,})[^\r\n]*\r?\n<<<SAPWOOD_RESULT>>>[ \t]*$/m, name);
    assert.doesNotMatch(prompt, /^<<<(?:END_SAPWOOD_RESULT|END_BODY)>>>[ \t]*\r?\n {0,3}(?:`{3,}|~{3,})[ \t]*$/m, name);
  }
});

// ── Content assertions — the specific #235 AC language, not just "the file changed somehow" ──

test("po.md (#235 AC item 3, item 4): the intent-prohibition is retained IN SPIRIT (producer ≠ PO still holds) but the old 'wanting to open a file = wrong role' line is gone, replaced by role-scoped read discretion that still forbids rewriting human why/what", () => {
  const body = readPrompt(defaultPoPromptPath());
  assert.ok(body.includes("producer ≠ PO."), "the core intent-prohibition heading survives verbatim");
  assert.ok(!body.includes("wanting to open a file or run tests"), "the old blanket file-read prohibition is gone");
  assert.ok(body.toLowerCase().includes("never rewrite"), "the why/what guardrail survives: reading never licenses rewriting human intent");
  assert.ok(body.includes("Read`/`Grep`/`Glob`"), "names the actual read-only grant, confined to the worktree");
});

test("architect.md (#235 AC item 3): no longer claims zero Read/repo access; instead directs citing code evidence when it drives a contradiction", () => {
  const body = readPrompt(defaultArchitectPromptPath());
  assert.ok(!body.includes("You have no Read tool and no repo checkout either"), "the old blanket denial is gone");
  assert.ok(body.includes("Read`/`Grep`/`Glob`"), "names the actual read-only grant");
  assert.ok(body.toLowerCase().includes("cite"), "directs citing code evidence, not just asserting a contradiction");
});

test("plan-reviewer.md (#235 AC item 3): judges plan EXECUTABILITY, explicitly warned off demanding implementation-shaped acceptance criteria", () => {
  const body = readPrompt(defaultPlanReviewerPromptPath());
  assert.ok(body.toLowerCase().includes("executab"), "names plan executability as the judgment target");
  assert.ok(
    body.toLowerCase().includes("implementation-shaped") || body.toLowerCase().includes("already implemented"),
    "explicitly warns against implementation-shaped acceptance criteria",
  );
  assert.ok(body.includes("Read`/`Grep`/`Glob`"), "names the actual read-only grant");
});

test("harvest.md (#235 AC item 3): repository reads must not alter ledger facts or expand comment scope — both limits stated explicitly", () => {
  const body = readPrompt(defaultHarvestPromptPath());
  assert.ok(body.toLowerCase().includes("ledger fact"), "names the ledger-facts invariant explicitly");
  assert.ok(
    body.toLowerCase().includes("expand") && body.toLowerCase().includes("comment"),
    "names the comment-scope invariant explicitly",
  );
  assert.ok(body.includes("Read`/`Grep`/`Glob`"), "names the actual read-only grant");
});

test("plan-drafter.md (#235 PR-B follow-up F1): the matrix grants plan-drafter Read/Grep/Glob (it's a peripheral role, no allowedTools override at its plan-review.ts callsite — falls back to the base), so the prompt's old 'wanting to open a file = wrong role' line — which contradicted that grant — is gone, replaced by role-scoped discretion; 'plan-author ≠ plan-approver' and 'never implement' survive verbatim in spirit", () => {
  const body = readPrompt(defaultPlanDrafterPromptPath());
  assert.ok(
    !body.includes("wanting to open a file or run tests"),
    "the old blanket file-read prohibition (contradicting the matrix) is gone",
  );
  assert.ok(body.includes("Read`/`Grep`/`Glob`"), "names the actual read-only grant");
  assert.ok(body.includes("plan-author ≠ plan-approver."), "the plan-author ≠ plan-approver boundary survives verbatim");
  assert.ok(body.toLowerCase().includes("never implement"), "the never-implement boundary survives");
  assert.ok(body.includes("producer ≠ plan-drafter."), "the core intent-prohibition heading survives verbatim");
});

// ── #283 (design #279 §5, D4): mandatory checkbox acceptance criteria ─────────────────────────

test("plan-reviewer.md (#283): mandates literal `- [ ]` checkbox acceptance criteria — malformed/prose AC is named as not-dispatchable, not just a style nit", () => {
  const body = readPrompt(defaultPlanReviewerPromptPath());
  assert.ok(body.includes("- [ ]"), "shows the literal checkbox syntax");
  assert.ok(body.toLowerCase().includes("not dispatchable"), "states the dispatch consequence explicitly");
});

test("plan-drafter.md (#283): mandates literal `- [ ]` checkbox acceptance criteria in whatever body it drafts", () => {
  const body = readPrompt(defaultPlanDrafterPromptPath());
  assert.ok(body.includes("- [ ] ...`"), "shows the literal checkbox syntax");
  assert.ok(body.toLowerCase().includes("not dispatchable"), "states the dispatch consequence explicitly");
});

// ── #457 (F36): execution-class ACs are plan noise — CI enforces them unconditionally ─────────

test("#457 plan-reviewer.md: execution-class ACs are named as noise to FLAG AND STRIP within minor-correction latitude, moving the execution step to the Verification plan", () => {
  const body = readPrompt(defaultPlanReviewerPromptPath());
  assert.ok(body.includes("Execution-class criteria are noise — flag and strip them."), "the flag-and-strip rule is present");
  assert.match(
    body,
    /"the test suite passes", "typecheck\/lint clean",\s+"CI green" and equivalents must never appear as acceptance criteria/,
  );
  assert.match(body, /fold the execution step into\s+the `## Verification plan`/);
});

test("#457 plan-reviewer-confirm.md: an execution-class AC on a legacy approved plan is a standing invalidate-check, with the brief directing the move to the Verification plan", () => {
  const body = readPrompt(defaultPlanConfirmPromptPath());
  assert.match(body, /A second standing check \(F36\): an execution-class acceptance\s+criterion/);
  assert.match(body, /a still-approved plan carrying one is `invalidate`/);
  assert.match(body, /folded into the\s+`## Verification plan`/);
});

test("#457 plan-drafter.md + po-decompose.md: AC-authoring guidance forbids CI/suite/typecheck status as a criterion — the Verification plan owns execution steps", () => {
  const drafter = readPrompt(defaultPlanDrafterPromptPath());
  assert.ok(drafter.includes("Never write CI/suite/typecheck status as an acceptance criterion"), "plan-drafter carries the rule");
  assert.match(drafter, /execution steps\s+belong in the `## Verification plan`/);
  const decompose = readPrompt(defaultPoDecomposePromptPath());
  assert.ok(decompose.includes("Never write CI/suite/typecheck status itself as a criterion"), "po-decompose carries the rule");
});

// ── #409: reuse-before-build + authoritative-signals-over-inferred, worded per role ───────────

test("#409 worker.md: the reuse check is a Method step placed BEFORE the red-test step and anchored on it, and authoritative-signals is a non-negotiable", () => {
  const body = readPrompt(defaultPromptPath());
  const reuse = body.indexOf("Check what already exists before you build.");
  const red = body.indexOf("Write the tests first (red).");
  assert.ok(reuse > 0, "the reuse step is present");
  assert.ok(reuse < red, "it precedes the red-test step rather than trailing it");
  assert.match(body, /a "red" test that passes immediately/, "anchored on the existing red-test signal, not a bolted-on survey process");
  assert.ok(body.includes("Authoritative signals over inferred ones."), "the signal rule is present");
  assert.ok(
    body.indexOf("Authoritative signals over inferred ones.") > body.indexOf("## Non-negotiables"),
    "and it lives under Non-negotiables, not buried in Method",
  );
});

test("#409 fix.md: carries the authoritative-signals rule (a fix leg is where patterns get widened to pass) and deliberately NOT the reuse step", () => {
  const body = readPrompt(defaultFixPromptPath());
  assert.ok(
    body.includes("Authoritative signals over inferred ones."),
    "the signal rule reaches the fix leg, which runs on its own prompt",
  );
  assert.match(
    body,
    /Widening a free-text pattern until the failing\s+case passes is not a fix/,
    "named in fix-leg terms, not copied from worker.md",
  );
  assert.ok(!body.includes("Check what already exists before you build."), "reuse-before-build is scoped to fresh work, not rework");
});

test("#409 plan-reviewer.md: unexecutable-mechanism plans are bounceable, WITHOUT licensing a re-litigation of the human's why/what", () => {
  const body = readPrompt(defaultPlanReviewerPromptPath());
  assert.ok(body.includes("Mechanism assumptions are plan defects."), "the plan-defect ground is present");
  assert.match(body, /A checkability defect, never a scope re-litigation\./, "explicitly bounded away from re-litigating scope");
  assert.ok(body.includes("not whether the underlying work is a good idea"), "the charter line forbidding re-litigation survives the edit");
  assert.ok(
    !body.includes("Check what already exists before you build."),
    "gate⓪ does not survey the repo for prior art — that would re-litigate a human's Ready call",
  );
});

test("#409 engine-reviewer.md: both finding classes are named, and the closed-output contract is untouched", () => {
  const body = readPrompt(defaultEngineReviewerPromptPath());
  assert.match(body, /re-implements a mechanism the\s+tree already provides/, "the reinvention finding class");
  assert.match(body, /pattern-matches free-form text\s+the project does not control/, "the inferred-signal finding class");
  assert.ok(
    body.includes("beyond exactly `perAC` and `findings`"),
    "no new output field was introduced — the closed schema statement still stands",
  );
});

test("#409 po.md: align mode states reuse-before-build as a rule, including the propose-nothing case", () => {
  const body = readPrompt(defaultPoPromptPath());
  assert.match(body, /In align mode this is a rule, not an option/, "upgraded from the old discretionary half-sentence");
  assert.match(body, /propose nothing/, "the propose-nothing case is explicit");
});

test("#409 doctrine-template.md: the authoritative-signals invariant carries the ordering, the contract-format exemption, and the failure-direction requirement", () => {
  const body = readPrompt(defaultDoctrineTemplatePath());
  assert.ok(body.includes("Authoritative signals over inferred text."), "the invariant is present in the shipped starter doctrine");
  assert.match(body, /bind to a structured\s+signal first/, "structured-signal-first ordering");
  assert.match(
    body,
    /are contracts, not text matching/,
    "the contract-internal-format exemption — this project's own grammars stay allowed",
  );
  assert.match(body, /name the failure direction/, "the false-positive-vs-false-negative choice must be stated");
});

test("#409: the rule is worded per role rather than one paragraph duplicated, and no shared prompt-include mechanism was added", () => {
  const worker = readPrompt(defaultPromptPath());
  const others = [
    defaultFixPromptPath(),
    defaultPlanReviewerPromptPath(),
    defaultEngineReviewerPromptPath(),
    defaultDoctrineTemplatePath(),
  ].map(readPrompt);
  const workerSentence = "To detect or classify an external condition, bind";
  assert.ok(worker.includes(workerSentence), "worker.md's own phrasing");
  for (const body of others) {
    assert.ok(!body.includes(workerSentence), "no file repeats worker.md's sentence verbatim — each role gets wording it can act on");
  }
  for (const body of [worker, ...others]) {
    assert.doesNotMatch(
      body,
      /\{\{\s*(?:include|partial|shared)[^}]*\}\}/,
      "no include/partial directive was introduced into the template language",
    );
  }
});

test("#409: plan-drafter.md and architect.md are deliberately untouched (charter conflicts recorded in the issue)", () => {
  assert.equal(sha256(readPrompt(defaultPlanDrafterPromptPath())), SNAPSHOT_HASHES["plan-drafter.md"]);
  assert.equal(sha256(readPrompt(defaultArchitectPromptPath())), SNAPSHOT_HASHES["architect.md"]);
});

// ── #410: WebSearch/WebFetch grant wording — po.md's mode-aware external-check section, the
// reworded "stay inside your scope" bullet, and both roles' first-class abstention wording ──

test("#410 po.md: names WebSearch/WebFetch and is mode-aware — the align/triage sections both reference {{po.mode}}, never leaking one mode's wording into the other", () => {
  const body = readPrompt(defaultPoPromptPath());
  assert.ok(body.includes("`WebSearch`/`WebFetch`"), "names the actual granted tools");
  assert.match(
    body,
    /### If `\{\{po\.mode\}\}` is `align`\s*\n\s*\nBefore proposing/,
    "align-mode external-check subsection, keyed on the template var",
  );
  assert.match(
    body,
    /### If `\{\{po\.mode\}\}` is `triage`\s*\n\s*\nYou may verify a factual claim/,
    "triage-mode external-check subsection, keyed on the template var",
  );
});

test("#410 po.md: triage may raise a verified why/what concern through the existing concern channel, never an edit", () => {
  const body = readPrompt(defaultPoPromptPath());
  assert.match(
    body,
    /VERIFIED problem with the\s*\nwhy\/what itself, you still never edit it: say so through the concern channel/,
    "triage's external check explicitly routes a verified problem to the concern channel, not an edit",
  );
});

test("#410 po.md: the 'stay inside your scope' bullet no longer reads as a ban on raising a concern — it names the edit ban and the concern channel side by side", () => {
  const body = readPrompt(defaultPoPromptPath());
  assert.match(body, /fix only the missing plan BY EDITING THE BODY/, "the ban is scoped to edits, stated explicitly");
  assert.match(
    body,
    /This is a\s*\n\s*ban on silent edits, not on speaking up: if you verify a genuine problem with the why\/what,\s*\n\s*raise it through the concern channel above/,
    "the bullet itself now points at the concern channel rather than reading as a blanket ban",
  );
});

test("#410 po.md + architect.md: both name a first-class abstention — an explicit way to report an external check that didn't resolve, never a silent omission or a claimed-but-unverified answer", () => {
  const po = readPrompt(defaultPoPromptPath());
  const architect = readPrompt(defaultArchitectPromptPath());
  assert.match(po, /Abstention — say so, never guess/, "po.md names the abstention channel as its own heading");
  assert.ok(
    po.includes("Never silently drop the attempt, and never write as if you'd confirmed something you"),
    "po.md's abstention wording is explicit about the failure mode it forbids",
  );
  assert.ok(
    po.includes('"I could not verify this" is a complete, honest answer'),
    "po.md states the abstention explicitly, not just implies it",
  );
  assert.ok(
    architect.includes("say so explicitly in your round design note rather than"),
    "architect.md routes abstention through its own always-emitted design-note channel",
  );
  assert.ok(
    architect.includes('verify this" belongs in the note as honestly as any contradiction or risk you flag.'),
    "architect.md states the abstention explicitly, not just implies it",
  );
});

test("#410 architect.md: names WebSearch/WebFetch alongside the existing read-only grant, gated on the deployment's own grant state", () => {
  const body = readPrompt(defaultArchitectPromptPath());
  assert.ok(body.includes("`WebSearch`/`WebFetch`"), "names the actual granted tools");
  assert.match(
    body,
    /unless this deployment has turned the\s*\ngrant off/,
    "names the config off-switch, never assumes the grant is unconditional",
  );
});
