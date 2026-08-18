// prompts.test.ts (#963): cross-role tests over shipped role prompt templates under
// engine/prompts/. A prompt/doctrine file is prose the retro role is chartered to reword — a
// test survives here only if it (a) checks agreement against a SECOND, independently-drifting
// source (a code constant/registry, another doc, a real parser/render pipeline), (b) is a
// negative lint over a banned class (fires only when a known-bad claim RETURNS, never on
// legitimate rewording), or (c) pins a safety floor by MARKER BLOCK + mirror-equality across
// carriers, never by sentence. See docs/REVIEW-DOCTRINE.md's PROSE-PIN sub-case.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { defaultPoolPromptPath, defaultPoPromptPath } from "../loop/align.js";
import { defaultPoDecomposePromptPath } from "../loop/decompose.js";
import { defaultHarvestPromptPath } from "../loop/harvest.js";
import { defaultDoctrineTemplatePath } from "../loop/init.js";
import { allowedToolsForRole, PROXY_ROLE_TOOL_MATRIX } from "../proxy/access.js";
import { defaultRetroPromptPath, RETRO_ALLOWED_TOOLS, RETRO_DISALLOWED_TOOLS } from "../retro/retro.js";
import { defaultEngineReviewerPromptPath } from "../review/engine-agent.js";
import { parseStructuredBlock, RESULT_BLOCK_END, RESULT_BLOCK_START } from "../state/structured-output.js";
import { defaultArchitectPromptPath } from "./architect.js";
import {
  ARCHITECT_ALLOWED_TOOLS,
  CONFIRM_ALLOWED_TOOLS,
  PO_ALIGN_ALLOWED_TOOLS,
  PO_ALLOWED_TOOLS,
  PO_TRIAGE_ALLOWED_TOOLS,
  ROLE_ALLOWED_TOOLS,
  ROLE_DISALLOWED_TOOLS,
} from "./peripheral.js";
import {
  defaultVerificationPlanConfirmPromptPath,
  defaultVerificationPlanDrafterPromptPath,
  defaultVerificationPlanReviewerPromptPath,
} from "./plan-review.js";
import { defaultFixPromptPath, defaultPromptPath } from "./worker.js";

function readPrompt(path: string): string {
  return readFileSync(path, "utf8");
}

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
  "verification-plan-reviewer": [defaultVerificationPlanReviewerPromptPath()],
  "verification-plan-drafter": [defaultVerificationPlanDrafterPromptPath()],
  "verification-plan-reviewer-confirm": [defaultVerificationPlanConfirmPromptPath()],
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

test("gate② round 3 pin: ROLES_WITH_DEFAULT_WEB_ACCESS matches peripheral.ts's actual web-grant constants — a hand-maintained set inside the test whose whole job is catching hand-maintained mirrors of code facts, so it is itself pinned against the source of truth rather than left free-floating", () => {
  // peripheral.ts's own doc comment (#410) names exactly these three as the only sessions the
  // WebSearch/WebFetch ternary can ever choose for: ARCHITECT_ALLOWED_TOOLS, PO_ALIGN_ALLOWED_
  // TOOLS, PO_TRIAGE_ALLOWED_TOOLS. If a fourth constant ever gains the grant, or one of these
  // three loses it, this assertion — not a silently-stale Set literal above — is what breaks.
  for (const [name, tools] of [
    ["ARCHITECT_ALLOWED_TOOLS", ARCHITECT_ALLOWED_TOOLS],
    ["PO_ALIGN_ALLOWED_TOOLS", PO_ALIGN_ALLOWED_TOOLS],
    ["PO_TRIAGE_ALLOWED_TOOLS", PO_TRIAGE_ALLOWED_TOOLS],
  ] as const) {
    assert.ok(
      tools.includes("WebSearch"),
      `peripheral.ts's ${name} no longer includes WebSearch — if this is intentional, ` +
        `ROLES_WITH_DEFAULT_WEB_ACCESS above must be updated to match (remove the role this ` +
        `constant backs); if it's a regression, fix peripheral.ts instead`,
    );
  }
  for (const [name, tools] of [
    ["ROLE_ALLOWED_TOOLS", ROLE_ALLOWED_TOOLS],
    ["PO_ALLOWED_TOOLS", PO_ALLOWED_TOOLS],
    ["CONFIRM_ALLOWED_TOOLS", CONFIRM_ALLOWED_TOOLS],
  ] as const) {
    assert.ok(
      !tools.includes("WebSearch"),
      `peripheral.ts's ${name} now includes WebSearch — a role backed by this ungranted ` +
        `baseline just gained web access. ROLES_WITH_DEFAULT_WEB_ACCESS above must be updated ` +
        `to add whichever role now resolves to ${name} with the grant, or the AC-2 test below ` +
        `will silently stop covering it — the #529 defect class, one level up`,
    );
  }
});

// ── #535: write-grant membership pin — docs/role-paradigm.md's write-scope-ladder tier-1
// membership (five peripheral roles hold no real write channel) and tier-2 (retro is the sixth
// role, and does NOT belong at tier 1) are both hand-maintained prose derived from these same
// exported constants. That membership drifted twice in one week (#530/#531 found tier-1 still
// listing retro despite its real write grant; #535 found tier-2's "none of the six" claim was
// false for the same reason) — same shape as ROLES_WITH_DEFAULT_WEB_ACCESS above, so it gets the
// same treatment: pinned against the source of truth rather than left free-floating.
test("#535 pin: which roles hold a real WRITE grant matches ROLE_ALLOWED_TOOLS/RETRO_ALLOWED_TOOLS — docs/role-paradigm.md's tier-1 membership needs updating when this fails", () => {
  // Exact comma-delimited token membership — plain `.includes("Edit")` would also match
  // `NotebookEdit`, which every one of these lists carries as its own distinct entry.
  const tokens = (list: string): Set<string> => new Set(list.split(","));

  // The six peripheral-role allow-lists — five roles plus the verification-plan-reviewer confirm variant:
  // po/verification-plan-reviewer/verification-plan-drafter/confirm all byte-identical to the base, architect/po-align/
  // po-triage widened only with WebSearch/WebFetch — must never include Write/Edit/MultiEdit,
  // and the shared deny-list must keep denying Bash outright — together, tier 1's "no write
  // tool channel exists at all" claim.
  for (const [name, tools] of [
    ["ROLE_ALLOWED_TOOLS", ROLE_ALLOWED_TOOLS],
    ["PO_ALLOWED_TOOLS", PO_ALLOWED_TOOLS],
    ["CONFIRM_ALLOWED_TOOLS", CONFIRM_ALLOWED_TOOLS],
    ["ARCHITECT_ALLOWED_TOOLS", ARCHITECT_ALLOWED_TOOLS],
    ["PO_ALIGN_ALLOWED_TOOLS", PO_ALIGN_ALLOWED_TOOLS],
    ["PO_TRIAGE_ALLOWED_TOOLS", PO_TRIAGE_ALLOWED_TOOLS],
  ] as const) {
    const granted = tokens(tools);
    for (const tool of ["Write", "Edit", "MultiEdit"] as const) {
      assert.ok(
        !granted.has(tool),
        `peripheral.ts's ${name} now includes ${tool} — a peripheral role just gained a real ` +
          `write channel. docs/role-paradigm.md's tier-1 membership needs updating.`,
      );
    }
  }
  assert.ok(
    tokens(ROLE_DISALLOWED_TOOLS).has("Bash"),
    "peripheral.ts's ROLE_DISALLOWED_TOOLS no longer denies Bash outright — the five " +
      "peripheral roles' tier-1 'no shell channel' claim depends on this. " +
      "docs/role-paradigm.md's tier-1 membership needs updating.",
  );

  // retro is the sixth role and the one that does NOT belong at tier 1: a real Write/Edit/
  // MultiEdit grant, plus Bash scoped to exactly these eight `git` subcommands (including
  // `commit` and `push`) — and its own deny-list must not deny any of them.
  const RETRO_GIT_SUBCOMMANDS = ["branch", "checkout", "add", "commit", "push", "diff", "status", "log"] as const;
  assert.strictEqual(RETRO_GIT_SUBCOMMANDS.length, 8, "sanity: this list itself must name eight subcommands");
  const retroGranted = tokens(RETRO_ALLOWED_TOOLS);
  const retroDenied = tokens(RETRO_DISALLOWED_TOOLS);
  for (const tool of ["Write", "Edit", "MultiEdit"] as const) {
    assert.ok(
      retroGranted.has(tool),
      `retro.ts's RETRO_ALLOWED_TOOLS no longer includes ${tool} — retro would move OUT of the ` +
        `real-write-grant category. docs/role-paradigm.md's tier-1/tier-2 membership needs updating.`,
    );
    assert.ok(
      !retroDenied.has(tool),
      `retro.ts's RETRO_DISALLOWED_TOOLS now denies ${tool} — retro's write grant is no longer ` +
        `real. docs/role-paradigm.md's tier-1/tier-2 membership needs updating.`,
    );
  }
  for (const sub of RETRO_GIT_SUBCOMMANDS) {
    const pattern = `Bash(git ${sub}*)`;
    assert.ok(
      retroGranted.has(pattern),
      `retro.ts's RETRO_ALLOWED_TOOLS is missing ${pattern} — the eight-subcommand git grant ` +
        `docs/role-paradigm.md describes has changed. Update the doc's tier-1 membership.`,
    );
    assert.ok(
      !retroDenied.has(pattern),
      `retro.ts's RETRO_DISALLOWED_TOOLS now denies ${pattern} — retro's git grant is no longer ` +
        `real for this subcommand. docs/role-paradigm.md's tier-1/tier-2 membership needs updating.`,
    );
  }

  // #536 gate② round-4 F3: the two claims above are presence-only. docs/role-paradigm.md's own
  // retro row goes further — "zero `gh` entries of any kind" in RETRO_ALLOWED_TOOLS, and "exactly
  // these eight" git subcommands, not "at least these eight". Neither is pinned above: a ninth
  // `Bash(git ...)` grant, or a `Bash(gh ...)` grant re-added to the allow-list, leaves every
  // assertion above green while falsifying the doc. The `gh` case also reopens a path around the
  // tier-3 `openProposalPR` choke point that the doc leans on.
  for (const tool of retroGranted) {
    assert.ok(
      !tool.startsWith("Bash(gh "),
      `retro.ts's RETRO_ALLOWED_TOOLS now includes ${tool} — a \`gh\` verb reached the allow-list, ` +
        `falsifying docs/role-paradigm.md's "zero \`gh\` entries of any kind" claim and opening a ` +
        `path around the tier-3 openProposalPR choke point. docs/role-paradigm.md needs updating.`,
    );
  }
  const retroGitGrantTokens = [...retroGranted].filter((t) => t.startsWith("Bash(git "));
  assert.strictEqual(
    retroGitGrantTokens.length,
    RETRO_GIT_SUBCOMMANDS.length,
    `retro.ts's RETRO_ALLOWED_TOOLS grants ${retroGitGrantTokens.length} \`git\` subcommand(s) ` +
      `(${retroGitGrantTokens.join(", ")}), not the eight docs/role-paradigm.md describes as ` +
      `"exactly these eight" — a subcommand was added or removed. docs/role-paradigm.md needs updating.`,
  );
});

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
  //
  // WIDENED to a second token, `` `gh` ``/`gh` — retro.md's own "you have no `gh` access at
  // all" carried the identical categorical-denial shape as "no GitHub access" but escaped this
  // exact regex on a single token swap (GitHub -> `gh`), which is exactly how it survived #529's
  // own AC-2 test while granted ISSUE_TOOLS on `main` — a LIVE drift, not a hypothetical one:
  // #551 flipped `proxy.enabled` to default true, so retro genuinely held these tools in every
  // deployment while this sentence claimed otherwise. `gh`'s own `\b...\b` word-boundary (not
  // just a bare substring check) is deliberate: "no gh access" must match, but "no high access"
  // (a real English phrase containing the literal substring "gh access") must NOT — verified by
  // its own test below. The optional surrounding backticks (`` `?...`? ``) tolerate retro.md's
  // own markdown-code-span styling without requiring it.
  const NO_GITHUB_ACCESS_DENIAL = /\b(?:no|never|nothing)\b[^.]{0,60}(?:\bGitHub\b|`?\bgh\b`?)\s+access\b/i;

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

  // Self-check, since the regex widening is the AC: the escaped case that motivated the widening,
  // exercised DIRECTLY against the regex (in ADDITION to the FOR loop above, which now also
  // exercises it live against retro.md's actual, fixed text — retro holds a non-empty grant, so
  // it's a subject of that loop too). This direct check asserts the widened regex itself is
  // correct independent of any one prompt's current wording, so a FUTURE role/prompt reusing this
  // exact phrasing is still caught even if retro.md's own text drifts again.
  assert.ok(NO_GITHUB_ACCESS_DENIAL.test("you have no `gh` access at all"), "retro.md's actual sentence must match the widened regex");
  assert.ok(NO_GITHUB_ACCESS_DENIAL.test("you have no gh access at all"), "the bare (unbackticked) form must also match");
  assert.ok(
    !NO_GITHUB_ACCESS_DENIAL.test("there is no high access door on this floor"),
    'false-positive guard: "high access" contains the literal substring "gh access" but must NOT match — the \\bgh\\b word boundary is what prevents it',
  );
});

// ── #559: shipped prompts are STATIC with respect to `proxy.enabled` — the same file serves the
// default (`true` since #551) AND the operator opt-out, with no template variable anywhere
// expressing which one this session got. Ruling on #559: keep the static prompts (option 2, the
// repo's default stance for a rare operator-deliberate configuration) rather than adding a
// substitution point, and keep the phrasing that #529 measured as the only one that produces
// calls — an ask that is IMPERATIVE whenever the tool is attached, carrying its own not-attached
// branch. That combination is followable in BOTH deployments, so what has to be guarded is not a
// wording rewrite (there is none) but the class returning: a flat possession claim or a flat
// lookup step, true only under the default. This test is that guard. It costs nothing at runtime
// and fires the moment a new (or edited) role prompt names a forge tool without saying what
// governs whether it is there.
//
// Ceiling, stated rather than overclaimed (same stance as AC-2's blind-spot note above): this is
// proximity text matching over a blank-line-delimited block, not semantics. A block whose
// conditional belongs to an unrelated sentence passes. The realistic failure mode this exists to
// catch — retro.md's own live "You hold read-only, proxy-MCP access ... (`mcp__forge__*`)", a flat
// claim landed by #557 that is simply false under `proxy.enabled: false` — does not have that
// shape.
const PROXY_ATTACHMENT_FRAMING =
  /\b(?:if|when|whenever|unless)\b[^.]{0,140}\b(?:attached|has|have|holds?|carries|no such tools?|isn't|is not|aren't|are not)\b/i;

test("#559: every shipped prompt block naming an `mcp__forge__` tool frames it against proxy attachment — a static prompt must be true under `proxy.enabled: true` AND `false`", () => {
  for (const [role, tools] of Object.entries(PROXY_ROLE_TOOL_MATRIX)) {
    if (tools.length === 0) continue;
    // worker is the one exempt role: its forge-naming prompt is fix.md, and a fix leg is only ever
    // dispatched when a proxy handle exists — `proxy.enabled: false` degrades every FIXABLE gate to
    // a `fix-loop-unwired:<reason>` needs-human escalation instead (cli.ts, conductor.ts), so no
    // session ever renders fix.md without the tools it names. worker.md (the ordinary dispatch leg,
    // still unwired for the proxy) names none at all.
    if (role === "worker") continue;

    const paths = ROLE_PROMPT_PATHS[role];
    assert.ok(paths !== undefined && paths.length > 0, `role "${role}" holds a forge grant but has no ROLE_PROMPT_PATHS entry`);

    for (const path of paths) {
      for (const block of readPrompt(path).split(/\n[ \t]*\n/)) {
        if (!block.includes("mcp__forge__")) continue;
        const normalized = block.replace(/\s+/g, " ").trim();
        assert.ok(
          PROXY_ATTACHMENT_FRAMING.test(normalized),
          `${path} (role "${role}") names an mcp__forge__ tool in a block that never says the ` +
            `tools' presence is conditional on this deployment's \`proxy.enabled\`: the prompt is ` +
            `static, so this block reads as false (a possession claim) or unfollowable (a lookup ` +
            `step) under the opt-out. Frame it — "when your session has these tools, …", or an ` +
            `imperative ask plus its own not-attached branch (po.md/architect.md are the shipped ` +
            `examples). Block:\n${normalized}`,
        );
      }
    }
  }

  // Self-checks on the regex itself, so a future prompt reusing either shape is caught even if
  // today's wording drifts: the flat claim must NOT pass, the three shipped framings must.
  assert.ok(
    !PROXY_ATTACHMENT_FRAMING.test("You hold read-only, proxy-MCP access to GitHub issues (`mcp__forge__*`) for grounding your analysis."),
    "a flat possession claim — the #557 shape this test was written against — must not pass",
  );
  assert.ok(
    PROXY_ATTACHMENT_FRAMING.test("When your session holds `mcp__forge__*` tools, they are a read-only window onto GitHub issues"),
    "the capability-paragraph framing every peripheral prompt uses must pass",
  );
  assert.ok(
    PROXY_ATTACHMENT_FRAMING.test(
      "**Cross-issue search (mandatory whenever the tool is attached — not conditional on whether it FEELS needed).**",
    ),
    "architect.md's imperative-when-attached ask — the #529-measured shape — must pass",
  );
  assert.ok(
    PROXY_ATTACHMENT_FRAMING.test(
      "If that tool isn't there, treat its absence like any other missing tool: say so in the issue body's rationale",
    ),
    "po.md's not-attached branch must pass on its own, without the ask's own condition nearby",
  );
});

test("shipped role prompts (#321, #963): every example sentinel block is plain text (no adjacent markdown fence), balanced, and accepted by the REAL structured-output parser — no test-local expected count", () => {
  const prompts: ReadonlyArray<readonly [name: string, path: string]> = [
    ["verification-plan-reviewer.md", defaultVerificationPlanReviewerPromptPath()],
    ["verification-plan-reviewer-confirm.md", defaultVerificationPlanConfirmPromptPath()],
    ["verification-plan-drafter.md", defaultVerificationPlanDrafterPromptPath()],
    ["po.md", defaultPoPromptPath()],
    ["po-pool.md", defaultPoolPromptPath()],
    ["po-decompose.md", defaultPoDecomposePromptPath()],
    ["architect.md", defaultArchitectPromptPath()],
    ["harvest.md", defaultHarvestPromptPath()],
  ];
  const startLine = new RegExp(`^${RESULT_BLOCK_START}[ \\t]*$`, "gm");
  const endLine = new RegExp(`^${RESULT_BLOCK_END}[ \\t]*$`, "gm");

  for (const [name, path] of prompts) {
    const prompt = readPrompt(path);

    const starts = prompt.match(startLine)?.length ?? 0;
    const ends = prompt.match(endLine)?.length ?? 0;
    assert.ok(starts > 0, `${name}: must ship at least one example sentinel block`);
    assert.equal(starts, ends, `${name}: every start sentinel must have a matching end sentinel`);

    assert.doesNotMatch(prompt, new RegExp(`^ {0,3}(?:\`{3,}|~{3,})[^\\r\\n]*\\r?\\n${RESULT_BLOCK_START}[ \\t]*$`, "m"), name);
    assert.doesNotMatch(prompt, new RegExp(`^${RESULT_BLOCK_END}[ \\t]*\\r?\\n {0,3}(?:\`{3,}|~{3,})[ \\t]*$`, "m"), name);

    // Real-parser mutation kill (#963 AC3): every RESULT_BLOCK_START..RESULT_BLOCK_END example
    // span the prompt shows must be something the REAL parser (parseStructuredBlock) actually
    // accepts — an example that regresses to a shape the parser rejects reddens here, not a
    // hand-maintained per-file count.
    let searchFrom = 0;
    let walked = 0;
    for (;;) {
      const s = prompt.indexOf(RESULT_BLOCK_START, searchFrom);
      if (s === -1) break;
      const e = prompt.indexOf(RESULT_BLOCK_END, s);
      assert.ok(e !== -1, `${name}: a RESULT_BLOCK_START example has no matching end sentinel`);
      const snippet = prompt.slice(s, e + RESULT_BLOCK_END.length);
      assert.ok(parseStructuredBlock(snippet) !== null, `${name}: example sentinel block is not accepted by the real parser:\n${snippet}`);
      walked++;
      searchFrom = e + RESULT_BLOCK_END.length;
    }
    assert.equal(walked, starts, `${name}: sanity — every start sentinel was walked by the parser check`);
  }
});

// ── Negative lints surviving the #235/#283/#457/#591 point-fix tests (#963): each of these was a
// positive prose pin (single-file oracle) EXCEPT its !includes/doesNotMatch half, which is a
// genuine negative lint — fires only if the specific retired/banned phrasing returns. ──────────

test("#235: no shipped peripheral prompt reintroduces the retired blanket file-read prohibition ('wanting to open a file or run tests') — every one of these roles holds a real Read/Grep/Glob grant", () => {
  for (const [name, path] of [
    ["po.md", defaultPoPromptPath()],
    ["verification-plan-drafter.md", defaultVerificationPlanDrafterPromptPath()],
  ] as const) {
    assert.ok(
      !readPrompt(path).includes("wanting to open a file or run tests"),
      `${name}: the old blanket file-read prohibition (contradicting the real matrix grant) must not return`,
    );
  }
});

test("architect.md: never reintroduces the retired 'You have no Read tool and no repo checkout either' claim — false against the real read-only grant", () => {
  assert.ok(!readPrompt(defaultArchitectPromptPath()).includes("You have no Read tool and no repo checkout either"));
});

test("#848: no shipped prompt teaches the retired paste-ready-patch deliverable — a human-merge-only path is changed only by a direct human-merged edit, never a producer-handed artifact", () => {
  // Negative-form closure over the ACTUAL shipped-prompt set — derived from a `readdir` of
  // engine/prompts (recursing into issue-templates/), never a hand-enumerated subset, so a prompt
  // added later is swept automatically. The machine analog of "the mechanism is gone everywhere",
  // checkable in a way a prose completeness claim is not.
  const promptsDir = dirname(defaultPromptPath());
  const shippedPrompts = readdirSync(promptsDir, { recursive: true }).filter(
    (f): f is string => typeof f === "string" && f.endsWith(".md"),
  );
  assert.ok(shippedPrompts.length >= 14, `sanity: expected the full prompts dir, got ${shippedPrompts.length} .md files`);
  for (const rel of shippedPrompts) {
    assert.doesNotMatch(
      readFileSync(join(promptsDir, rel), "utf8"),
      /paste-ready|patch-deliverable/i,
      `${rel}: the paste-ready-patch mechanism is retired (#848) — carve-out remainder / needs-human only`,
    );
  }
});

// ── #409: reuse-before-build + authoritative-signals-over-inferred, worded per role ───────────

test("#409 fix.md/verification-plan-reviewer.md: reuse-before-build is scoped to fresh work — neither the fix leg nor gate⓪ reintroduces worker.md's survey step", () => {
  for (const [name, path] of [
    ["fix.md", defaultFixPromptPath()],
    ["verification-plan-reviewer.md", defaultVerificationPlanReviewerPromptPath()],
  ] as const) {
    assert.ok(
      !readPrompt(path).includes("Check what already exists before you build."),
      `${name}: reuse-before-build is worker.md's own step, scoped to fresh work — a fix leg is rework, and gate⓪ does not survey the repo for prior art`,
    );
  }
});

test("#354 fix.md: the retired false guard-denial claim, its unresolvable-in-target-repos issue reference, and the restated tier-C field list never return", () => {
  const body = readPrompt(defaultFixPromptPath());
  assert.ok(!body.includes("guard-denied"), "the false guard-semantics claim is gone");
  assert.ok(!body.includes("#652"), "the unresolvable-in-target-repos issue reference is gone");
  assert.ok(
    !body.includes("actor, steps, timestamp"),
    "the tier-C field list is not restated — cite the ac-evidence-tiers doctrine line by name instead",
  );
});

test("#409: no shipped prompt other than worker.md repeats worker.md's authoritative-signals sentence verbatim, and no file introduces a shared prompt-include directive", () => {
  const worker = readPrompt(defaultPromptPath());
  const others = [
    defaultFixPromptPath(),
    defaultVerificationPlanReviewerPromptPath(),
    defaultEngineReviewerPromptPath(),
    defaultDoctrineTemplatePath(),
  ].map(readPrompt);
  const workerSentence = "To detect or classify an external condition, bind";
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

// A reverse-direction test ("a role holding NO PROXY_ROLE_TOOL_MATRIX grant must not have a
// prompt that asks for an mcp__forge__ lookup") was drafted alongside AC-2 above during a
// since-reversed proposal to narrow this matrix to two roles. It is deliberately NOT restored:
// every role in PROXY_ROLE_TOOL_MATRIX holds a non-empty grant (nine ISSUE_TOOLS roles plus
// worker's PR_TOOLS — see access.ts), so the test would have zero real subjects among shipped
// roles — its own sanity assertions (`allowedToolsForRole(role)` must be `[]`) would fail
// immediately for every role it named, not pass vacuously. A version scoped to a synthetic
// non-existent role would exercise nothing but the `?? []` fallback `allowedToolsForRole`'s own
// unit tests (access.test.ts) already cover directly. AC-2 above remains the live, non-vacuous
// guard in this direction: it fails the moment a prompt's prose disagrees with its role's actual
// (currently non-empty, for all nine) matrix grant.

test("po-pool.md: holds the SAME non-empty ISSUE_TOOLS grant as architect.ts (allowedToolsForRole, cross-artifact against access.ts)", () => {
  assert.deepEqual(
    [...allowedToolsForRole("po-pool")].sort(),
    [...allowedToolsForRole("architect")].sort(),
    "sanity: po-pool holds the same non-empty ISSUE_TOOLS grant as architect",
  );
});

// ── #605: engine-open-PR is the ORDINARY path for a worker lane, not a rescue fallback — the
// worker's job ends at push, never at `gh pr create`. Same forbidden-instruction pattern
// prompts.test.ts already applies to retro.md above (#235). ──

test("#605 worker.md: never carries an affirmative 'open a pull request' step for the worker session", () => {
  const body = readPrompt(defaultPromptPath());
  assert.ok(!body.includes("gh pr create"), "worker.md must not instruct: gh pr create");
  assert.ok(
    !/\*\*Open a pull request\*\*/i.test(body),
    "worker.md must not carry an affirmative 'open a pull request' step for the worker session",
  );
});

test("#605: no shipped prompt (worker.md, fix.md, or any peripheral prompt) instructs `gh pr create`", () => {
  for (const path of [
    defaultPromptPath(),
    defaultFixPromptPath(),
    defaultPoPromptPath(),
    defaultArchitectPromptPath(),
    defaultVerificationPlanReviewerPromptPath(),
    defaultVerificationPlanConfirmPromptPath(),
    defaultVerificationPlanDrafterPromptPath(),
    defaultHarvestPromptPath(),
    defaultRetroPromptPath(),
    defaultPoolPromptPath(),
    defaultPoDecomposePromptPath(),
  ]) {
    assert.ok(!readPrompt(path).includes("gh pr create"), `${path} must not instruct gh pr create`);
  }
});

// ── #628 (owner ruling 2026-08-04): AC-evidence doctrine tiered by trust origin, carried into
// the plan-authoring/plan-judging prompts. docs/security.md's "Doctrine lines" is the tier
// definitions' one home — every carrier below cites it rather than restating the tier prose, so
// these assertions pin the AUTHORING-DEFAULT rule's key phrases, not the tier definitions
// themselves (those live in docs/security.md, outside this test file's scope). ──────────────────

test("#628 (#963 CONVERT, codex terra fix leg): every one of the three authoring prompts (po.md, po-decompose.md, verification-plan-drafter.md) ships the sapwood:floor:evidence-tiers marker block, byte-equal (whitespace-normalized) across carriers — wording may change freely as long as all carriers change together", () => {
  assertFloorMirrored("evidence-tiers", EVIDENCE_TIER_CARRIERS);
});

test("#628: no carrier re-restates the tier A/B/C/D definitions themselves — docs/security.md stays the single doctrine home", () => {
  const carriers = [
    readPrompt(defaultPoPromptPath()),
    readPrompt(defaultPoDecomposePromptPath()),
    readPrompt(defaultVerificationPlanDrafterPromptPath()),
    readPrompt(defaultVerificationPlanReviewerPromptPath()),
  ];
  for (const body of carriers) {
    assert.doesNotMatch(
      body,
      /engine-verified.*Deterministic engine code computes the fact itself/s,
      "a prompt carrier must not restate tier A's own definition — docs/security.md owns it",
    );
  }
});

// ── #653: gate⓪ contract-vs-discussion veto duty — both comment-reading judgment prompts ──────
//
// PR #651 round 1's incident: gate⓪ roles already hold issue-comment read tools (PROXY_ROLE_TOOL_
// MATRIX, proxy/access.ts's ISSUE_TOOLS grant), but no prompt asked them to compare the body
// against the discussion for CONTRADICTION. #652 makes staleness deterministic (a cursor check);
// this duty is the judgment-side backstop for contradiction, which no cursor can detect. Tier A
// (prompt-text presence): a tier-C live probe is out of scope for a static engine test — see the
// issue's verification plan.

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// #963 (CONVERT, replacing a verbatim-sentence pin): the #653 veto duty is now a
// `<!-- sapwood:floor:<name> -->` marker block in every carrier — wording may evolve freely as
// long as every carrier changes together (mirror-pair), never pinned by sentence. See #672's
// twin mechanism below and docs/REVIEW-DOCTRINE.md's PROSE-PIN sub-case.
const FLOOR_CARRIERS: Readonly<Record<string, string>> = {
  "verification-plan-reviewer.md": defaultVerificationPlanReviewerPromptPath(),
  "verification-plan-reviewer-confirm.md": defaultVerificationPlanConfirmPromptPath(),
};

// #628's evidence-tier rule (below) has a DIFFERENT carrier set (the three AC-authoring
// prompts) — same marker/mirror mechanism, generalized over `carriers` rather than a second
// hand-copied helper.
const EVIDENCE_TIER_CARRIERS: Readonly<Record<string, string>> = {
  "po.md": defaultPoPromptPath(),
  "po-decompose.md": defaultPoDecomposePromptPath(),
  "verification-plan-drafter.md": defaultVerificationPlanDrafterPromptPath(),
};

function extractFloor(body: string, floorName: string): string {
  const startTag = `<!-- sapwood:floor:${floorName} -->`;
  const endTag = `<!-- /sapwood:floor:${floorName} -->`;
  const start = body.indexOf(startTag);
  const end = body.indexOf(endTag);
  assert.ok(start >= 0 && end > start, `missing or malformed <!-- sapwood:floor:${floorName} --> block`);
  return normalizeWhitespace(body.slice(start + startTag.length, end));
}

function assertFloorMirrored(floorName: string, carriers: Readonly<Record<string, string>> = FLOOR_CARRIERS): void {
  const blocks = Object.entries(carriers).map(([name, path]) => [name, extractFloor(readPrompt(path), floorName)] as const);
  const [[firstName, firstBlock], ...rest] = blocks;
  assert.ok(firstBlock.length > 0, `sanity: ${firstName}'s sapwood:floor:${floorName} block is non-empty`);
  for (const [name, block] of rest) {
    assert.equal(
      block,
      firstBlock,
      `${name}'s sapwood:floor:${floorName} block diverges from ${firstName}'s — carriers must change together`,
    );
  }
}

test("#653 (#963 CONVERT): every carrier ships the sapwood:floor:gate0-comment-veto marker block, byte-equal (whitespace-normalized) across carriers — wording may change freely as long as all carriers change together", () => {
  assertFloorMirrored("gate0-comment-veto");
});

// #657: broadened per adjudication — (a) whitespace-normalize before matching, so a
// line-wrap-shaped drift ("Comments\nconfirm freshness") can't slip a regex anchored on a
// single space; (b) the forbidden set covered only freshness/provenance/authorization framing,
// leaving approve/authorize/expand-scope formulations — the OTHER three verbs the duty text
// itself vetoes ("never justify approve/confirm, expand scope, or authorize a body change") —
// unchecked. Still negative-form only (doctrine): this is a non-exhaustive forbidden set, not a
// claim that these patterns are the only way a positive-completeness claim could be written.
const FORBIDDEN_POSITIVE_FORMULATIONS: RegExp[] = [
  /comments? (?:confirm|establish|prove|guarantee) (?:freshness|provenance|authorization)/i,
  /comments? (?:can|may|could)? ?(?:justify|authorize) (?:an? )?(?:approve|approval|confirm|confirmation|scope expansion|a scope change|a body change|the body change)/i,
  /comments? (?:approve|confirm) (?:the )?(?:plan|pr|issue|scope|body)/i,
  /comments? (?:expand|widen) (?:the )?scope/i,
];

test("#653/#657: the duty is veto-only — no positive-completeness or approval/scope-authorization claim is introduced alongside it (whitespace-normalized, so line-wrap drift cannot slip the match)", () => {
  const bodies = [readPrompt(defaultVerificationPlanReviewerPromptPath()), readPrompt(defaultVerificationPlanConfirmPromptPath())];
  for (const rawBody of bodies) {
    const body = normalizeWhitespace(rawBody);
    for (const pattern of FORBIDDEN_POSITIVE_FORMULATIONS) {
      assert.doesNotMatch(body, pattern, `comments must never be framed with a forbidden positive/authorization formulation: ${pattern}`);
    }
  }
});

// ── #672 (Codex gate② P2 on #665): the `<issue-comments>` block is untrusted, world-writable
// content — a comment body containing a literal `</issue-comments>` (or a forged peer tag)
// could otherwise escape the data block and read as prompt structure instead of quoted comment
// content. plan-review.ts's renderCommentDigest escapes the payload (code-side fix, covered by
// plan-review.test.ts's own adversarial test); this pair checks the PROMPT TEXT itself marks the
// block untrusted, immediately before it, in both files that render it.

test("#672 (#963 CONVERT): every carrier ships the sapwood:floor:untrusted-issue-comments marker block, byte-equal (whitespace-normalized) across carriers, and it precedes the <issue-comments> block it frames", () => {
  assertFloorMirrored("untrusted-issue-comments");
  for (const [name, path] of Object.entries(FLOOR_CARRIERS)) {
    const body = readPrompt(path);
    const floorStart = body.indexOf("<!-- sapwood:floor:untrusted-issue-comments -->");
    const blockIdx = body.indexOf("<issue-comments>");
    assert.ok(floorStart >= 0, `${name}: missing the untrusted-issue-comments floor block`);
    assert.ok(floorStart < blockIdx, `${name}: the untrusted-data floor must precede the <issue-comments> block it describes`);
  }
});

// ── retro round #328, re-scoped after its gate② correction produced a SECOND unrepresentable
// design (2026-08-06 supervisor ruling): a plan-authoring/plan-judging fix that tells gate⓪/the
// drafter to "drop" or "reword toward the PR description" a record-the-ruling AC is prompt text
// prescribing an output the machinery cannot express — validateDrafterOutput rejects a body with
// zero checkbox ACs, and engine-reviewer.md's `perAC` schema has exactly three statuses, none of
// which fits an AC whose entire content is unverifiable. Fixing the sole-AC case needs an
// output-contract change (a real "not producer-verifiable" status, or a real drafter escalation
// output), not prompt wording — that is tracked as a follow-up, deliberately out of scope here.
// This PR keeps ONLY the one improvement that needs no new state: engine-reviewer.md's exception
// is scoped to the issue-edit SUB-REQUIREMENT of a MIXED AC, whose other, code-verifiable clause
// still gets a normal status computed from real evidence — a legal `perAC` entry today, with or
// without this fix. verification-plan-reviewer.md/-confirm.md/-drafter.md carry no #328 content
// at all — the sole-AC case is untouched by this PR.
//
// Third gate② round on this same bullet (still 2026-08-06): the first version told the reviewer
// to write an advisory `kind: "design"` finding for the sub-clause — but `finding-axes.ts`'s
// `ADVISORY_ELIGIBLE_KINDS` is `{style, test-coverage}` only; `effectiveSeverity` forces every
// other kind (including `"design"`) back to `"blocking"`, and `deriveApprovalResult` rejects the
// WHOLE PR on any blocking finding regardless of `perAC` status — so the mandated finding
// silently re-blocked the exact AC this bullet exists to unblock (confirmed by reading
// finding-axes.ts directly). Owner ruling (2026-08-06), superseding a proposed "switch to a
// non-blocking channel" fix: delete the finding instruction UNCONDITIONALLY, don't look for or
// switch to any other channel even where one exists — mandating a finding (blocking, advisory, or
// "optionally note it") strips the reviewing model's own judgment about whether the sub-clause is
// worth reporting at all. The bullet says nothing about emitting anything; it governs the AC's
// STATUS only. If the reviewer independently decides the sub-clause is worth a finding, that is
// its own call, on its own reading — never something this prompt instructs. ────────────────────

test("#328 (re-scoped): engine-reviewer.md's issue-body-edit exception never reintroduces the retired blanket 'never cannot-confirm' wording, the false claim-accepted promotion, or a mandated finding for the sub-clause", () => {
  const body = normalizeWhitespace(readPrompt(defaultEngineReviewerPromptPath()));
  assert.ok(
    !/An AC that requires editing the issue body itself is never `cannot-confirm`/.test(body),
    "the old blanket 'whole AC is never cannot-confirm' wording must be gone",
  );
  assert.ok(
    !/Tier it `claim-accepted` instead when the PR body or diff states the ruling clearly/.test(body),
    "must not promote the issue-edit sub-requirement to claim-accepted — there is no claim to accept, since the producer cannot write to that channel at all",
  );
  assert.ok(
    !/Write an advisory `kind: "design"` finding/.test(body),
    "must not mandate a finding for the sub-clause — `design` is not in ADVISORY_ELIGIBLE_KINDS, so the engine would force it back to blocking and re-reject the AC this bullet unblocks",
  );
  assert.ok(
    !/findings` entry for the sub-clause/i.test(body) && !/raise a finding/i.test(body) && !/optionally note it/i.test(body),
    "must say NOTHING about emitting a finding for the sub-clause — required, non-blocking-channel, or optional all strip the reviewing model's own judgment; owner ruling is silence, not a softer instruction",
  );
});

test("#328 (re-scoped): verification-plan-reviewer.md, verification-plan-reviewer-confirm.md, and verification-plan-drafter.md carry no #328-era record-the-ruling AC instruction — the sole-AC gap is a machinery follow-up, not prompt wording", () => {
  const bodies = {
    "verification-plan-reviewer.md": readPrompt(defaultVerificationPlanReviewerPromptPath()),
    "verification-plan-reviewer-confirm.md": readPrompt(defaultVerificationPlanConfirmPromptPath()),
    "verification-plan-drafter.md": readPrompt(defaultVerificationPlanDrafterPromptPath()),
  };
  for (const [name, body] of Object.entries(bodies)) {
    assert.ok(
      !/record the ruling on this issue/i.test(body),
      `${name}: must not (re)introduce the record-the-ruling AC instruction without the machinery to represent its outcome`,
    );
    assert.ok(
      !/be DROPPED/.test(body),
      `${name}: must not instruct that the AC be dropped — a sole-AC drop yields zero checkboxes, which validateDrafterOutput rejects`,
    );
  }
});

test("#701 (Tier B): no shipped role prompt hardcodes 'English' as a literal working-language directive — the #701 sweep replaced every such mention with a `{{lang.*}}` template-var reference", () => {
  const allPromptPaths: Record<string, string> = {
    "po.md": defaultPoPromptPath(),
    "po-decompose.md": defaultPoDecomposePromptPath(),
    "po-pool.md": defaultPoolPromptPath(),
    "verification-plan-drafter.md": defaultVerificationPlanDrafterPromptPath(),
    "verification-plan-reviewer.md": defaultVerificationPlanReviewerPromptPath(),
    "verification-plan-reviewer-confirm.md": defaultVerificationPlanConfirmPromptPath(),
    "architect.md": defaultArchitectPromptPath(),
    "harvest.md": defaultHarvestPromptPath(),
    "retro.md": defaultRetroPromptPath(),
    "worker.md": defaultPromptPath(),
    "fix.md": defaultFixPromptPath(),
    "engine-reviewer.md": defaultEngineReviewerPromptPath(),
  };
  for (const [name, path] of Object.entries(allPromptPaths)) {
    const body = readPrompt(path);
    assert.ok(!/\bEnglish\b/.test(body), `${name}: must not name "English" as a hardcoded language directive — use {{lang.*}} instead`);
  }
});

// #963 (CONVERT, replacing the static `.includes("{{lang.*}}")` sweep above): a role prompt
// dropping its `{{lang.*}}` reference is now caught by RENDERING the real shipped file with a
// distinctive non-default `language.*` value and asserting that value reaches the output — see
// worker.test.ts/align.test.ts/decompose.test.ts/architect.test.ts/harvest.test.ts/retro.test.ts/
// plan-review.test.ts/engine-agent.test.ts's own "#963" render tests, one per role prompt. A
// static `.includes("{{lang.*}}")` check on the raw template proves only that the LITERAL TOKEN
// sits somewhere in the file — never that a real render actually threads the configured value
// through it, and it is itself a single-file prose pin (PROSE-PIN, docs/REVIEW-DOCTRINE.md).
