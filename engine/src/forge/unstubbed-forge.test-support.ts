// #403 (F25), PR #430 gate② round 1 (P1): test-only support module — the base class every
// per-suite `FakeForge`/`MinimalForge` double extends so that it is a STRUCTURALLY COMPLETE
// `IForge` without each suite restating 46 members it never calls.
//
// Why this exists at all: #403's whole enforcement claim is "a fixture that omits a required
// `now` fails to compile". That is only true if fixtures are compiled — and before this file,
// sixteen suites could not be, because each declared a partial `implements IForge` double that
// never grew the members IForge grew (781 of the 1091 errors were that ONE mistake, repeated at
// every call site that passed such a double where an `IForge` was expected, plus 14 more on the
// class declarations themselves). Those files sat on a named exclusion list, which meant the
// compiler could not catch a missing clock in any of them. Making the doubles whole is what
// deletes the exclusion list, so it is #403's work after all, not a separate change.
//
// Deliberately NOT a hand-written class with 46 stub bodies: that is the thing that rots the
// moment IForge grows a member, which is exactly how the debt accumulated the first time. The
// prototype is populated from a name list, and `MISSING_FROM_LIST` below makes the compiler
// reject the file if that list ever falls behind `keyof IForge` — so adding a member to IForge
// forces this list to be updated in the same change, instead of silently re-excluding sixteen
// suites.
//
// Every member throws. A double that a test actually drives overrides the ones it needs, and TS
// still checks those overrides against IForge's real signatures (that is the part worth keeping);
// anything the fixture never stubbed fails LOUDLY and by name if some code path reaches it,
// rather than reading `undefined` and failing somewhere unrelated.
//
// `.test-support.ts`, not `.ts`: `tsconfig.json` (the BUILD config) excludes this suffix
// alongside `src/**/*.test.ts`, so it never reaches `dist/`; `tsconfig.typecheck.json` includes
// it, like every other test file.
import type { IForge } from "./forge.js";

/** Every `IForge` member name. Kept in one place so the prototype below can be built from it. */
const IFORGE_MEMBERS = [
  "addIssueComment",
  "addLabel",
  "addPRComment",
  "addPRLabel",
  "addSubIssue",
  "branchExists",
  "claimIssue",
  "countOpenIssuesInMilestone",
  "createIssue",
  "detectOwnerKind",
  "ensureRepoLabels",
  "getCommitsSince",
  "getIssueBody",
  "getIssueComments",
  "getIssueLabels",
  "getIssueMeta",
  "getIssueRelations",
  "getIssuesNeedingPlanReview",
  "getIssuesNeedingPlanTriage",
  "getPoolEligibleIssues",
  "getPRChangedFiles",
  "getPRChecks",
  "getPRComments",
  "getPRDetails",
  "getPRDiff",
  "getPRReviewData",
  "getPRReviews",
  "getPRReviewThreads",
  "getPRStatus",
  "getReadyIssues",
  "getReviewThreadCommentsTail",
  "getSubIssues",
  "listIssuesAbsentFromBoard",
  "listMilestoneTitles",
  "listOpenIssueNumbers",
  "listOpenIssues",
  "listUnplacedIssues",
  "mergePR",
  "openPR",
  "readStartupReconcileData",
  "removeLabel",
  "replyToReviewThread",
  "resolveReviewThread",
  "searchIssues",
  "setBoardStatus",
  "updateIssueBody",
] as const;

/** Compile-time completeness guard: if `IForge` grows a member the list above doesn't name, this
 *  assignment fails with that member's name in the error, because the type becomes a string union
 *  that `true` is not assignable to. `never extends never ? true : never` -> `true`, so a complete
 *  list compiles to a plain `const _: true = true`. */
type MissingFromList = Exclude<keyof IForge, (typeof IFORGE_MEMBERS)[number]>;
const _MEMBER_LIST_IS_COMPLETE: [MissingFromList] extends [never] ? true : MissingFromList = true;
void _MEMBER_LIST_IS_COMPLETE;

class UnstubbedForgeBase {}
for (const member of IFORGE_MEMBERS) {
  (UnstubbedForgeBase.prototype as Record<string, unknown>)[member] = function unstubbed(): never {
    throw new Error(`fake forge: ${member}() is not stubbed in this fixture`);
  };
}

/** Base class for a test double that only implements the slice of `IForge` its own suite drives.
 *  `class FakeForge extends UnstubbedForge implements IForge { … }` — the `implements` clause stays
 *  meaningful (TS still checks every member the subclass DOES define against IForge's signature);
 *  what it no longer does is demand 46 bodies from a fixture that calls three. */
export const UnstubbedForge = UnstubbedForgeBase as unknown as new () => IForge;
