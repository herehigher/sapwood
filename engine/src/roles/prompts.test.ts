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
import { allowedToolsForRole, PROXY_ROLE_TOOL_MATRIX } from "../proxy/access.js";
import { defaultRetroPromptPath, RETRO_ALLOWED_TOOLS, RETRO_DISALLOWED_TOOLS } from "../retro/retro.js";
import { defaultEngineReviewerPromptPath } from "../review/engine-agent.js";
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
  // po-align/po-triage hold a default WebFetch grant, which reaches github.com.
  // #529 (gate② round 3, optional cleanup): even "no issue-API access at all" was still an
  // access CLAIM (WebFetch can reach api.github.com for a public repo too) — reworded to point
  // at the substituted context instead of asserting any "no X access" claim at all.
  // #528: intentional edit — the digest now also carries the bounded RECENTLY CLOSED tail, so the
  // prompt explains the `[recently closed — do not re-propose]` annotation and says the dedup
  // check covers it. Same class of fix as #444 above, on the state axis instead of the milestone
  // axis: the session could not see a fact that shipped and closed, so it re-proposed one (#525
  // vs. #461, hours apart).
  // #442: intentional edit — align mode now requires a one-line `Origin:` evidence statement in
  // every proposed body (event ids / lane / episode / parent issue, or the literal `static
  // scan`), and says outright that the engine only checks the line EXISTS. Round provenance was
  // already engine-stamped; EVIDENCE provenance had no carrier at all, so a run-observation
  // finding and a repo-reading one were indistinguishable on the issue page.
  "po.md": "6a6c6bbec284ce563a3e6b7277c9cfc3d8fe302eb41fa2241dabdfae071ad9c7",
  // #529: the categorical "no tool call of yours reaches GitHub" denial is replaced with the
  // conditional form — true whether or not the forge MCP proxy is attached to this session.
  // #529 D1 (gate② round 2): the fallback clause's "no GitHub access at all" was itself false —
  // architect holds a default WebFetch grant, which reaches github.com.
  // #529 (gate② round 3, optional cleanup): same further rewording as po.md above.
  // #533 originally proposed removing this grant; the owner reversed that direction. architect
  // KEEPS its ISSUE_TOOLS grant — the surviving change from the #533 work is the ask itself,
  // rewritten from conditional prose to an unconditional-when-attached numbered task-list step:
  // "Cross-issue search" (search_issues on a candidate's key terms for related open/
  // recently-updated issues OUTSIDE the pool, issue_details the hits before judging) plus a
  // doc-drift rule (a locked decision surfacing only in an issue, never the architecture chapter,
  // is doc drift, never authoritative).
  // gate② #557 (finding 9): "search_issues returns a title and labels only, never body text"
  // was false — the tool returns number/title/state/labels/updatedAt (IssueSearchResult), and
  // "only" denied fields the "open or recently-updated" ask right above depends on. Named the
  // real field set at both mentions (the capability paragraph and the Cross-issue search step).
  // #533 reversal cleanup: the fallback clause ("if you have no such tools, you have no way to
  // see issues outside this round's candidate/pool lists") was itself a false completeness claim
  // — architect also holds a default WebFetch/WebSearch grant, named a few lines below. Rewritten
  // to enumerate the real fallback set (substituted context, worktree, WebSearch/WebFetch when
  // attached) instead of asserting a closure over all of them.
  // #413: hash moved again for the gate⓪ rename — architect.md's single reference to the drafter
  // role by name follows the new name. No charter, grant, or instruction changed by the rename.
  "architect.md": "4b028b293c378d4fb2b5d376e44c9c30afe2f0add05d4ba76cf48440f4c612e7",
  // #457 (F36): intentional edits — execution-class ACs are plan noise (CI already enforces
  // ci.requiredChecks unconditionally): verification-plan-reviewer flags-and-strips them, the confirm pass
  // invalidates legacy plans carrying them, drafter/decompose never author them.
  // #529: same categorical→conditional GitHub-access fix as architect.md.
  // #413: the three gate⓪ files were renamed on disk (plan-reviewer.md ->
  // verification-plan-reviewer.md, ...) and their in-body self-references and the
  // {{roles.*.maxDraftCycles}} token follow the new role/config names. The names say what the
  // role gates: an issue's VERIFICATION PLAN, not its plan of work. The rename carries the
  // #533-reversal content edits below unchanged; both moves land in each hash exactly once.
  // #533 proposed removing plan-reviewer's ISSUE_TOOLS grant; the owner reversed that direction
  // — the grant is unchanged (still in `proxy/access.ts`'s matrix). This edit drops the original
  // closure claim ("if you have no such tools, you have no GitHub access at all") that #533's own
  // narrowing had left in place — a completeness claim over "GitHub access" as a whole, banned by
  // the same rule #529 exists to enforce — in favor of a plain "when your session has the tools"
  // statement with no claim about the absent case.
  // retro round #281: the "Feasibility against human-merge-only paths" check named
  // "security-relevant config" as the protected slice of sapwood.config.*, which read as
  // scoping the block to guard/reviewer/merge-mode fields — issue #386 (a comment-only
  // budgetUsdSoft edit) slipped past gate⓪ on that reading and the resulting PR (#562) then
  // failed gate② for real, unfixably (the guard blocks the whole file by path, not by field).
  // Both bullets now say so explicitly.
  "verification-plan-reviewer.md": "132d51eebdad5dd0edf1e746baa4c9d93ad306782be7d1fdcb8b8c74f544e403",
  // Same grant-preserved, closure-dropped fix as verification-plan-reviewer.md above —
  // the confirm pass's one question (repo drift) is answered by its own READ-ONLY worktree
  // grant OR, now again, its forge lookup when attached; the prose no longer claims totality
  // either way.
  "verification-plan-reviewer-confirm.md": "8be3f563358fb335803c0755f445c0c42ecdeb9804c853b3855a63a6e0a70d75",
  // Same grant-preserved, closure-dropped fix as verification-plan-reviewer.md above — the
  // drafter's brief is still its primary instruction set; the forge grant (never removed) is a
  // read-only aid, never a write path, exactly as this file has always said.
  // retro round #281: same fix as verification-plan-reviewer.md above, mirrored into the
  // drafter's own "if the brief flags a human-merge-only conflict" bullet.
  "verification-plan-drafter.md": "1be2278294a53e7702b1f860e0aafbfe4933495c928b218878434cae3e19cb9f",
  // Same grant-preserved, closure-dropped fix as verification-plan-reviewer.md above — targets
  // still arrive as bare #N and comments are still round-stats boilerplate; harvest's forge
  // grant was never removed, so the capability paragraph again names it (when attached) instead
  // of denying it.
  "harvest.md": "657601c73250a9fd169d909779cddec8a23433936bf20a99533e827def2fd52e",
  // #453 (design #402 R5): intentional edit — the digest's new finding-class tendency table is
  // pointed at, with the design-source rule and the stated blind spot. The FIRST deliberate
  // change to this file since #235 pinned it as "already code-aware, do not touch"; that ruling
  // was about tool scope, not about the role's analysis inputs, so it is not re-litigated here.
  // #533 proposed removing retro's ISSUE_TOOLS grant; the owner reversed that direction — the
  // grant stays, which means the "you have no `gh` access at all" sentence #533's removal would
  // have made true is FALSE again, and live: #551 flipped `proxy.enabled` to default true, so
  // retro genuinely holds these tools in every deployment. Fixed to state what's actually true —
  // no `gh` CLI, no shell beyond git (`RETRO_ALLOWED_TOOLS` is git-only Bash), but a real
  // read-only `mcp__forge__*` issue grant — as a single positive statement about that one named
  // channel, not a list of what retro lacks.
  "retro.md": "76996f79411b5fa30c36c2e9f28b041e889fa7927f26ccca7b76cdc23c85a01d",
  // #529: same categorical→conditional GitHub-access fix as architect.md.
  // #533 proposed removing po-pool's ISSUE_TOOLS grant and substituting each candidate's full
  // body in its place; the owner reversed the grant-removal half only. po-pool KEEPS its
  // ISSUE_TOOLS grant (unchanged in `proxy/access.ts`) — the substitution survives independently:
  // `align.ts::buildPoolCandidateDigest` still renders each candidate with
  // `architect.ts::formatCandidate` (number, title, labels, FULL body) instead of a title-only
  // line, under the SAME existing cap (`roles.po.backlogDigestMaxChars`) — the architect phase
  // pays for this exact render one phase later regardless, so substituting it here is free
  // either way, independent of what po-pool's own grant is. The prompt now says both are true: a
  // full body is substituted per candidate, AND the forge tools remain available for anything
  // beyond what a shown candidate's entry carries.
  // gate② #557 (finding 6): the flat "every candidate below already carries its full issue
  // body" / "everything you need to decide is already here" claims were unconditional over code
  // that truncates whole records past the cap with no lookup fallback — now scoped to what's
  // actually rendered, and the session is told what the omission marker means.
  // #558: the omission marker now NAMES the omitted candidates instead of only counting them, so
  // the paragraph describing it says what a named-but-not-shown number means: cross-referenceable,
  // still not selectable, and degrading to the old bare count if the number list itself won't fit.
  "po-pool.md": "d93bb9f0f314718df8465a06d7583fdfe45901efe94ef9c9a99275755184b1e6",
  "po-decompose.md": "3289b0f37585b84fdce67319f9ae4b2e82c8873b13b2a292adef25b1bca79ae2",
};

test("prompt snapshot: po.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultPoPromptPath())), SNAPSHOT_HASHES["po.md"]);
});

test("prompt snapshot: architect.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultArchitectPromptPath())), SNAPSHOT_HASHES["architect.md"]);
});

test("prompt snapshot: verification-plan-reviewer.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultVerificationPlanReviewerPromptPath())), SNAPSHOT_HASHES["verification-plan-reviewer.md"]);
});

test("prompt snapshot: verification-plan-reviewer-confirm.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultVerificationPlanConfirmPromptPath())), SNAPSHOT_HASHES["verification-plan-reviewer-confirm.md"]);
});

test("prompt snapshot: verification-plan-drafter.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultVerificationPlanDrafterPromptPath())), SNAPSHOT_HASHES["verification-plan-drafter.md"]);
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

test("shipped role prompts (#321): sentinel examples are plain text with no adjacent markdown fences", () => {
  const prompts: ReadonlyArray<readonly [name: string, path: string, sentinelCount: number]> = [
    ["verification-plan-reviewer.md", defaultVerificationPlanReviewerPromptPath(), 2],
    ["verification-plan-reviewer-confirm.md", defaultVerificationPlanConfirmPromptPath(), 2],
    ["verification-plan-drafter.md", defaultVerificationPlanDrafterPromptPath(), 1],
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

test("verification-plan-reviewer.md (#235 AC item 3): judges plan EXECUTABILITY, explicitly warned off demanding implementation-shaped acceptance criteria", () => {
  const body = readPrompt(defaultVerificationPlanReviewerPromptPath());
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

test("verification-plan-drafter.md (#235 PR-B follow-up F1): the matrix grants verification-plan-drafter Read/Grep/Glob (it's a peripheral role, no allowedTools override at its plan-review.ts callsite — falls back to the base), so the prompt's old 'wanting to open a file = wrong role' line — which contradicted that grant — is gone, replaced by role-scoped discretion; 'plan-author ≠ plan-approver' and 'never implement' survive verbatim in spirit", () => {
  const body = readPrompt(defaultVerificationPlanDrafterPromptPath());
  assert.ok(
    !body.includes("wanting to open a file or run tests"),
    "the old blanket file-read prohibition (contradicting the matrix) is gone",
  );
  assert.ok(body.includes("Read`/`Grep`/`Glob`"), "names the actual read-only grant");
  assert.ok(body.includes("plan-author ≠ plan-approver."), "the plan-author ≠ plan-approver boundary survives verbatim");
  assert.ok(body.toLowerCase().includes("never implement"), "the never-implement boundary survives");
  assert.ok(body.includes("producer ≠ verification-plan-drafter."), "the core intent-prohibition heading survives verbatim");
});

// ── #283 (design #279 §5, D4): mandatory checkbox acceptance criteria ─────────────────────────

test("verification-plan-reviewer.md (#283): mandates literal `- [ ]` checkbox acceptance criteria — malformed/prose AC is named as not-dispatchable, not just a style nit", () => {
  const body = readPrompt(defaultVerificationPlanReviewerPromptPath());
  assert.ok(body.includes("- [ ]"), "shows the literal checkbox syntax");
  assert.ok(body.toLowerCase().includes("not dispatchable"), "states the dispatch consequence explicitly");
});

test("verification-plan-drafter.md (#283): mandates literal `- [ ]` checkbox acceptance criteria in whatever body it drafts", () => {
  const body = readPrompt(defaultVerificationPlanDrafterPromptPath());
  assert.ok(body.includes("- [ ] ...`"), "shows the literal checkbox syntax");
  assert.ok(body.toLowerCase().includes("not dispatchable"), "states the dispatch consequence explicitly");
});

// ── #457 (F36): execution-class ACs are plan noise — CI enforces them unconditionally ─────────

test("#457 verification-plan-reviewer.md: execution-class ACs are named as noise to FLAG AND STRIP within minor-correction latitude, moving the execution step to the Verification plan", () => {
  const body = readPrompt(defaultVerificationPlanReviewerPromptPath());
  assert.ok(body.includes("Execution-class criteria are noise — flag and strip them."), "the flag-and-strip rule is present");
  assert.match(
    body,
    /"the test suite passes", "typecheck\/lint clean",\s+"CI green" and equivalents must never appear as acceptance criteria/,
  );
  assert.match(body, /fold the execution step into\s+the `## Verification plan`/);
});

test("#457 verification-plan-reviewer-confirm.md: an execution-class AC on a legacy approved plan is a standing invalidate-check, with the brief directing the move to the Verification plan", () => {
  const body = readPrompt(defaultVerificationPlanConfirmPromptPath());
  assert.match(body, /A second standing check \(F36\): an execution-class acceptance\s+criterion/);
  assert.match(body, /a still-approved plan carrying one is `invalidate`/);
  assert.match(body, /folded into the\s+`## Verification plan`/);
});

test("#457 verification-plan-drafter.md + po-decompose.md: AC-authoring guidance forbids CI/suite/typecheck status as a criterion — the Verification plan owns execution steps", () => {
  const drafter = readPrompt(defaultVerificationPlanDrafterPromptPath());
  assert.ok(
    drafter.includes("Never write CI/suite/typecheck status as an acceptance criterion"),
    "verification-plan-drafter carries the rule",
  );
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

test("#409 verification-plan-reviewer.md: unexecutable-mechanism plans are bounceable, WITHOUT licensing a re-litigation of the human's why/what", () => {
  const body = readPrompt(defaultVerificationPlanReviewerPromptPath());
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

test("#442 po.md: align mode requires an `Origin:` evidence line, names `static scan` as the honest literal for a repo-reading finding, and says the engine never reads what it says", () => {
  const body = readPrompt(defaultPoPromptPath());
  assert.match(body, /`Origin:`/, "the required line is named literally, the way the engine's presence check spells it");
  assert.match(body, /static scan/, "the literal a purely repo-derived finding must use");
  assert.match(body, /never reads what it says|never parses it|for human triage only/i, "stated as prose, not a machine anchor");
  assert.match(body, /invalid output/, "a missing Origin line is an invalid session output, not a soft nudge");
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
    defaultVerificationPlanReviewerPromptPath(),
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

test("#409: architect.md carries no #409 charter change (conflicts recorded in the issue) — later hash moves are each recorded above", () => {
  // verification-plan-drafter.md was untouched by #409 specifically, but has since been edited
  // for unrelated reasons (the forge-tool-ask rework, #413's rename, and retro round #281's
  // human-merge-only scope fix — each recorded in its own SNAPSHOT_HASHES comment above) — its
  // hash is covered by the direct snapshot test above instead of this #409-scoped assertion.
  assert.equal(sha256(readPrompt(defaultArchitectPromptPath())), SNAPSHOT_HASHES["architect.md"]);
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

test("architect.md: the cross-issue search ask is UNCONDITIONAL-when-attached and lives in the numbered task list (never only in the capability paragraph) — a permission the model may decline is what produced #529's own measured zero in the first place", () => {
  const body = readPrompt(defaultArchitectPromptPath());
  const taskListStart = body.indexOf("## What you do — every pass, all of these");
  assert.ok(taskListStart > 0, "sanity: the numbered task list section exists");
  const taskList = body.slice(taskListStart);
  assert.match(
    taskList,
    /\*\*Cross-issue search \(mandatory whenever the tool is attached/,
    "the ask is a numbered task-list item, not just capability prose",
  );
  assert.ok(taskList.includes("mcp__forge__search_issues"), "names the actual tool to call");
  assert.ok(taskList.includes("mcp__forge__issue_details"), "names the required follow-up (search_issues carries no body text)");
  assert.ok(
    taskList.toLowerCase().includes("doc drift"),
    "names the doc-drift rule — a decision found only in an issue is never treated as authoritative",
  );
  assert.match(
    taskList,
    /OUTSIDE this\s+round's pool/,
    "scoped to the cross-issue-consistency mission, not the round's own candidate/pool lists",
  );
});

test("po-pool.md: names its mcp__forge__ grant (po-pool holds ISSUE_TOOLS, unchanged) AND describes the digest as carrying each candidate's full body, not just its title — the two are independent, not exclusive", () => {
  const body = readPrompt(defaultPoolPromptPath());
  assert.deepEqual(
    [...allowedToolsForRole("po-pool")].sort(),
    [...allowedToolsForRole("architect")].sort(),
    "sanity: po-pool holds the same non-empty ISSUE_TOOLS grant as architect",
  );
  assert.ok(body.includes("mcp__forge__"), "po-pool's real forge grant is named in its prompt, not silently omitted");
  assert.ok(body.includes("full issue body"), "names what the substituted digest now actually carries");
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
