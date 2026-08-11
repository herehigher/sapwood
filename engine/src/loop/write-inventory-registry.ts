// #796: the declarative registry backing docs/PLAN.md's "structured-output write inventory"
// table (section "Validation depth ∝ decision weight") and docs/role-paradigm.md's "Per-role
// sections". This is the SOURCE OF TRUTH read by write-inventory.test.ts's bidirectional
// completeness check — see that file's own doc for why bidirectional (a structured-output
// session with no table row can silently drop its stated validation-depth obligation; a table
// row naming a role with no such write path is dead documentation asserting a guarantee about
// nothing). Mirrors probe-signals.ts's shape: one flat array, one entry per distinct
// structured-output session dispatch site whose validated output DIRECTLY drives an `IForge`
// write (never a session whose output only decides control flow into another such site — see
// the `verification-plan-reviewer-confirm` exclusion note below).
//
// Adding a new structured-output write path — this issue's own finding: `po-pool` shipped in
// #212/#233 without ever landing in docs/PLAN.md's table — means adding a row HERE too. That is
// what turns the table's own claim ("every future … change … updates the table below in the
// same PR") into a checked fact instead of a prose promise gate② had no mechanism to enforce.

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
  // #796: `verification-plan-reviewer-confirm` (plan-review.ts::confirmOneIssue) is
  // DELIBERATELY NOT its own entry — its own doc comment states the confirm branch "makes zero
  // forge writes"; a `confirm` verdict writes nothing, and an `invalidate` verdict routes into
  // `reviewOneIssue`'s OWN seeded write path, which validates and writes through the
  // `verification-plan-reviewer` entry above, not a second time here. Registering it separately
  // would assert a write path that does not exist — exactly the false-row failure mode
  // direction 2 (table row -> real write path) below exists to catch.
  {
    roleId: "verification-plan-drafter",
    tableRole: "verification-plan-drafter",
    callSite: "plan-review.ts::reviewOneIssue (draft_request)",
  },
  { roleId: "harvest", tableRole: "harvest", callSite: "harvest.ts::createHarvestStub" },
  { roleId: "retro", tableRole: "retro", callSite: "retro.ts::createRetroStub" },
];
