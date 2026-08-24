// #796: the declarative registry backing docs/PLAN.md's "structured-output write inventory"
// table (section "Validation depth ∝ decision weight") and docs/reference/role-paradigm.md's "Per-role
// sections". This is the SOURCE OF TRUTH read by write-inventory.test.ts's bidirectional
// completeness check — see that file's own doc for why bidirectional (a structured-output
// session with no table row can silently drop its stated validation-depth obligation; a table
// row naming a role with no such write path is dead documentation asserting a guarantee about
// nothing). Mirrors probe-signals.ts's shape: one flat array, one entry per distinct
// structured-output session dispatch site whose validated output DIRECTLY drives (or, via a
// seed into another such site, indirectly but ACTUALLY drives — see the
// `verification-plan-reviewer-confirm` entry below) an `IForge` write.
//
// Adding a new structured-output write path — this issue's own finding: `po-pool` shipped in
// #212/#233 without ever landing in docs/PLAN.md's table — means adding a row HERE too. That is
// what turns the table's own claim ("every future … change … updates the table below in the
// same PR") into a checked fact instead of a prose promise gate② had no mechanism to enforce.
//
// #796 gate② (sol-high round 1): a hand-maintained registry checked only against the DOCS is
// still only half-structural — nothing forced a NEW production dispatch site to be registered
// here in the first place (reproduced directly: deleting the `po-pool` entry+row while leaving
// `align.ts:1554`'s real `roleId: "po-pool"` dispatch intact left every doc-only test green).
// write-inventory.test.ts's source-scan closes that direction: it greps `engine/src` (excluding
// `*.test.ts` and this file) for the `roleId: "…"` literal-string dispatch convention every real
// call site below uses, and asserts every id it finds is EITHER a `roleId` in
// WRITE_INVENTORY_ROLE_SESSIONS below OR named in WRITE_INVENTORY_NON_REGISTRY_ROLE_IDS with a
// justification — so a new write-driving `roleId` cannot exist only in implementation, and a
// non-write `roleId` cannot be silently exempted without a reviewable reason on record. Bounded
// note: the scan only recognizes the literal-string convention (`roleId: "some-id"`); a `roleId`
// assembled from a variable/template would evade it. Today's codebase has none — every
// production dispatch site is a literal (verified by the same grep this test runs) — so this is
// a documented blind spot, not a currently-live one.

/** One structured-output session whose validated output drives at least one `IForge` write. */
export interface WriteInventoryRoleEntry {
  /** The exact `roleId` string passed as `session.roleId` at the session's dispatch call site
   *  (the string `runSessionWithRetry`/`RoleRunner.run` receives — grep for `roleId: "…"` at
   *  the `callSite` below to confirm it hasn't drifted). */
  roleId: string;
  /** The canonical identifier the matching docs/PLAN.md table row's
   *  `<!-- sapwood:write-inventory-role:ID -->` marker must carry. Several `roleId`s may share
   *  one `tableRole` when they are documented as a single row — e.g. `po-align`/`po-triage`
   *  under "PO / aligning", which is one write-inventory row for one round-phase. */
  tableRole: string;
  /** Where the session is dispatched from, for a reader chasing a mismatch — not read by the
   *  completeness test itself. */
  callSite: string;
}

export const WRITE_INVENTORY_ROLE_SESSIONS: readonly WriteInventoryRoleEntry[] = [
  { roleId: "po-decompose", tableRole: "po-decompose", callSite: "decompose.ts (createDecomposeStub)" },
  { roleId: "po-align", tableRole: "po-aligning", callSite: "align.ts::createAligningStub (align mode)" },
  { roleId: "po-triage", tableRole: "po-aligning", callSite: "align.ts::createAligningStub (triage mode)" },
  { roleId: "po-pool", tableRole: "po-pool", callSite: "align.ts::runPoolSelection" },
  { roleId: "architect", tableRole: "architect", callSite: "architect.ts::createArchitectStub" },
  { roleId: "verification-plan-reviewer", tableRole: "verification-plan-reviewer", callSite: "plan-review.ts::reviewOneIssue" },
  // #796 gate② (sol-high round 1, correcting round 1's own wrong exclusion): a `confirm` verdict
  // does write nothing — but an `invalidate` verdict's validated BODY (the confirm session's OWN
  // structured output) is threaded straight into `reviewOneIssue` as a seeded `draft_request`
  // (`plan-review.ts:1197-1200`, `decision.body: validated.body!`), which posts it as the
  // reviewer-brief `addIssueComment` (`plan-review.ts:919`) and drives the drafter session BEFORE
  // any ordinary `verification-plan-reviewer` session ever runs for that issue. So this session's
  // own output DOES drive a real write on that path — "confirm writes nothing" was true for only
  // one of its two verdicts, not license to omit the whole dispatch site. Shares the
  // `verification-plan-reviewer` `tableRole` (same "one row documents this shared write path"
  // shape as `po-align`/`po-triage` sharing `po-aligning` below) rather than a table row of its
  // own — the write it produces IS the reviewer's write path, not a second one.
  {
    roleId: "verification-plan-reviewer-confirm",
    tableRole: "verification-plan-reviewer",
    callSite: "plan-review.ts::confirmOneIssue (invalidate verdict, seeds reviewOneIssue)",
  },
  {
    roleId: "verification-plan-drafter",
    tableRole: "verification-plan-drafter",
    callSite: "plan-review.ts::reviewOneIssue (draft_request)",
  },
  { roleId: "harvest", tableRole: "harvest", callSite: "harvest.ts::createHarvestStub" },
  { roleId: "retro", tableRole: "retro", callSite: "retro.ts::createRetroStub" },
];

/** A production `roleId: "…"` dispatch site the source-scan finds that is DELIBERATELY not a
 *  registry entry above — each needs a reviewable reason, checked the same way a registry
 *  entry's absence is: `write-inventory.test.ts`'s source-scan direction fails closed on any
 *  scanned `roleId` in NEITHER list. Prefer an EMPTY array here — every entry is a claim that a
 *  real production session dispatch is exempt from this file's completeness guarantee, which
 *  deserves the same scrutiny a missing registry row would. */
export interface WriteInventoryAllowlistEntry {
  roleId: string;
  reason: string;
}

export const WRITE_INVENTORY_NON_REGISTRY_ROLE_IDS: readonly WriteInventoryAllowlistEntry[] = [
  {
    roleId: "engine-reviewer",
    reason:
      "the merge gate's engine-agent PR-review session (engine/src/review/engine-agent.ts::attempt), " +
      "dispatched through review-session.ts::runReviewSession — a DIFFERENT session mechanism from " +
      "RoleRunner.run/runSessionWithRetry, which every entry above uses, and outside the scope of " +
      "docs/PLAN.md's write-inventory table, which documents the round-phase PERIPHERAL roles " +
      "round.ts's own SEQUENCE dispatches (aligning/architecting/plan_review/harvesting/retro), not " +
      "the separate merge-gate review mechanism. Its verdict feeds the human-merge-only merge gate " +
      "(merge-driver.ts/reviewer.ts — docs/security.md's Human-merge-only paths), which this PR is " +
      "expressly forbidden from touching; adding it to the peripheral-role table would misdescribe " +
      "what that table is an inventory OF.",
  },
];
