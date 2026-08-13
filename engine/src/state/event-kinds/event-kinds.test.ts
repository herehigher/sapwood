// event-kinds.test.ts (#425): the CROSS-LIST COMPLETENESS test — the piece that would have caught
// `fix-rounds-capped` missing from ESCALATION_SOURCES for four review rounds.
//
// Kind-spelling enforcement (appendEvent's narrowed signature) catches a typo. It cannot catch a
// kind that is valid, written correctly, and simply absent from a consumer list that logically
// needs it. That is what this file checks, BIDIRECTIONALLY: every kind tagged for a surface
// appears in that surface's derived list, and every member of that list is tagged for it. Both
// directions matter — the forward one catches an omission, the reverse one catches a consumer
// that grew a hand-written entry the registry never heard of.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DISSENT_DECISION_KINDS, DISSENT_RECEIPT_KIND } from "../../loop/dissent.js";
import { CLEAR_KINDS, ESCALATION_SOURCES } from "../../loop/escalation-reconcile.js";
import { FIX_LEG_CURSOR_KINDS } from "../../loop/fix-response.js";
import { ROUND_ARTIFACT_EVENT_KINDS } from "../../loop/round-artifact.js";
import { RETRO_EVENT_KINDS } from "../../retro/retro.js";
import { PR_TOUCHED_EVENT_KINDS } from "../../retro/retro-digest.js";
import { MERGED_WITNESS_KINDS } from "../state.js";
import {
  ESCALATION_SOURCE_TAGS,
  EVENT_KIND_DOMAINS,
  EVENT_KIND_NAMES,
  EVENT_KINDS,
  type EventKind,
  type EventTag,
  isKnownEventKind,
  kindsTagged,
} from "./index.js";
import { type Actionability, defineKinds } from "./types.js";

/** The bidirectional assertion, written once: `list` must be exactly the set of kinds tagged
 *  `tag` — no member missing (the cross-list-omission class), no extra (a consumer re-spelling a
 *  kind the registry never declared). Compared as SETS: derivation order is an implementation
 *  detail no consumer depends on. */
function assertDerivedFromTag(label: string, tag: EventTag, list: readonly string[]): void {
  const tagged = [...kindsTagged(tag)].sort();
  const actual = [...new Set(list)].sort();
  assert.deepEqual(actual, tagged, `${label} must be exactly the kinds tagged "${tag}"`);
  assert.equal(actual.length, list.length, `${label} must not contain duplicates`);
}

test("registry: every declared kind appears in exactly one domain file", () => {
  const seen = new Map<string, string>();
  for (const [domain, table] of Object.entries(EVENT_KIND_DOMAINS)) {
    for (const kind of Object.keys(table)) {
      const prior = seen.get(kind);
      assert.equal(prior, undefined, `"${kind}" is declared in both ${prior} and ${domain} — the barrel would silently merge them`);
      seen.set(kind, domain);
    }
  }
  assert.deepEqual([...seen.keys()].sort(), Object.keys(EVENT_KINDS).sort());
});

test("registry: no kind carries more than one escalation-source proof mode", () => {
  for (const [kind, entry] of Object.entries(EVENT_KINDS)) {
    const proofs = (entry.tags as readonly EventTag[]).filter((t): t is (typeof ESCALATION_SOURCE_TAGS)[number] =>
      (ESCALATION_SOURCE_TAGS as readonly string[]).includes(t),
    );
    assert.ok(
      proofs.length <= 1,
      `"${kind}" carries ${proofs.length} escalation-source tags (${proofs.join(", ")}) — a kind proves its label exactly one way`,
    );
  }
});

test("registry: no kind declares the same tag twice", () => {
  for (const [kind, entry] of Object.entries(EVENT_KINDS)) {
    assert.equal(new Set(entry.tags).size, entry.tags.length, `"${kind}" repeats a tag`);
  }
});

test("consumer list: RETRO_EVENT_KINDS is derived from the retro tag", () => {
  assertDerivedFromTag("RETRO_EVENT_KINDS", "retro", RETRO_EVENT_KINDS);
});

test("consumer list: PR_TOUCHED_EVENT_KINDS is derived from the pr-touched tag", () => {
  assertDerivedFromTag("PR_TOUCHED_EVENT_KINDS", "pr-touched", PR_TOUCHED_EVENT_KINDS);
});

test("consumer list: ROUND_ARTIFACT_EVENT_KINDS is derived from the round-artifact tag", () => {
  assertDerivedFromTag("ROUND_ARTIFACT_EVENT_KINDS", "round-artifact", ROUND_ARTIFACT_EVENT_KINDS);
});

test("consumer list: CLEAR_KINDS is derived from the escalation-clear tag", () => {
  assertDerivedFromTag("CLEAR_KINDS", "escalation-clear", CLEAR_KINDS);
});

test("consumer list: dissent's decision/receipt kinds are derived from their tags", () => {
  assertDerivedFromTag("DISSENT_DECISION_KINDS", "dissent-decision", DISSENT_DECISION_KINDS);
  assertDerivedFromTag("DISSENT_RECEIPT_KIND", "dissent-receipt", [DISSENT_RECEIPT_KIND]);
});

test("consumer list: fix-response's journal-cursor kinds are derived from the fix-leg tag", () => {
  assertDerivedFromTag("FIX_LEG_CURSOR_KINDS", "fix-leg", FIX_LEG_CURSOR_KINDS);
});

test("consumer list: state.ts's MERGED_WITNESS_KINDS is derived from the merged-witness tag (#803)", () => {
  assertDerivedFromTag("MERGED_WITNESS_KINDS", "merged-witness", MERGED_WITNESS_KINDS);
});

test("consumer list: ESCALATION_SOURCES is derived from the escalation-source:* tags", () => {
  // Membership, both directions...
  const tagged = ESCALATION_SOURCE_TAGS.flatMap((tag) => kindsTagged(tag)).sort();
  assert.deepEqual(Object.keys(ESCALATION_SOURCES).sort(), tagged);
  // ...and the proof mode each row carries, which is the half a plain membership check would
  // miss: a kind tagged `never` but registered `always` is precisely the false-clear machine
  // escalation-reconcile.ts's doc calls strictly worse than a zombie row.
  for (const tag of ESCALATION_SOURCE_TAGS) {
    const proof = tag.slice("escalation-source:".length);
    for (const kind of kindsTagged(tag)) {
      const entry = ESCALATION_SOURCES[kind];
      assert.notEqual(entry, undefined, `"${kind}" is tagged ${tag} but missing from ESCALATION_SOURCES`);
      assert.equal(typeof entry === "string" ? entry : entry?.proof, proof, `"${kind}" is tagged ${tag} but registered differently`);
    }
  }
});

/** The GOLDEN escalation-source set — every kind that leaves work waiting on a person, with the
 *  proof mode it claims. Deliberately hand-written, and deliberately NOT derived: the derivation
 *  above makes registry and consumer move together BY CONSTRUCTION, which means it can no longer
 *  see the failure that actually bit this repo — a kind that SHOULD be a source and is tagged
 *  nowhere at all (`fix-rounds-capped`, the most common escalation of all, missing for four
 *  review rounds; #295 round 4). This list is the tripwire for that: adding or removing an
 *  attention source becomes a deliberate two-place act, and a silent drop reds here.
 *
 *  Adding a row is cheap and correct when you meant it. If you are here because this test went
 *  red on a kind you just added, the question to answer first is escalation-reconcile.ts's own:
 *  does this kind carry an ISSUE and provably apply the needs-human label? If not, it belongs in
 *  that module's DELIBERATELY-ABSENT block instead, not here. */
const GOLDEN_ESCALATION_SOURCES: Record<string, "always" | "payload" | "never"> = {
  "architect-repeat-drop-escalated": "payload",
  "ceiling-escalated": "never",
  "concern-post-escalated": "payload",
  "drive-needs-human": "payload",
  "drive-no-pr": "always",
  "env-failure-preserved": "never",
  "estop-lane-swept": "never",
  "fix-leg-undecidable": "always",
  "fix-leg-verdict-rerun": "always",
  "fix-rounds-capped": "always",
  "gated-reentry-capped": "always",
  "gated-reentry-capped-label-failed": "never",
  "orphan-pr-escalated": "payload",
  "plan-review-escalated": "never",
  "reclaim-done": "always",
  "reclaim-failed": "always",
  "resume-capped": "always",
  "resume-undecidable": "always",
  "review-disputed": "always",
  "review-non-convergent": "always",
  "rollback-escalated": "never",
  "round-pool-removal-capped": "payload",
  "verify-na-proposed": "always",
};

test("completeness: the escalation-source set matches its golden list, kind for kind", () => {
  const tagged: Record<string, string> = {};
  for (const tag of ESCALATION_SOURCE_TAGS) {
    for (const kind of kindsTagged(tag)) tagged[kind] = tag.slice("escalation-source:".length);
  }
  assert.deepEqual(tagged, GOLDEN_ESCALATION_SOURCES);
});

test("completeness: the historical fix-rounds-capped omission stays impossible", () => {
  // The direct replay of the #295-round-4 bug, called out by name because it is the one this
  // machinery exists for: valid kind, written correctly, absent from ESCALATION_SOURCES, and no
  // external merge/close/label-removal could ever resolve it.
  const kind: EventKind = "fix-rounds-capped";
  assert.ok(EVENT_KINDS[kind].tags.includes("escalation-source:always"));
  assert.equal(ESCALATION_SOURCES[kind], "always");
});

// ── #643: required per-kind glossary fields ──────────────────────────────────────────────────
//
// Event-kind MEANINGS were tribal knowledge — code comments no role session ever reads, and the
// documented failure mode is a supervisor guessing an event's significance from its name alone
// (dogfood batch 6). This is the runtime half of the guarantee: every declared kind carries a
// non-empty `meaning` and a valid `actionability`. The COMPILE-TIME half — a kind declared
// without them must not compile at all — is the `@ts-expect-error` fixture below it.

const VALID_ACTIONABILITY: readonly Actionability[] = ["routine", "expected-noise", "investigate", "intervene"];

test("registry: every declared kind carries a non-empty glossary meaning and a valid actionability", () => {
  for (const [kind, entry] of Object.entries(EVENT_KINDS)) {
    assert.equal(typeof entry.meaning, "string", `"${kind}" is missing a glossary meaning`);
    assert.ok(entry.meaning.trim().length > 0, `"${kind}"'s glossary meaning must not be empty`);
    assert.ok(
      (VALID_ACTIONABILITY as readonly string[]).includes(entry.actionability),
      `"${kind}" has an invalid actionability "${entry.actionability}"`,
    );
  }
});

// #643 AC: "adding an event kind without glossary fields is a COMPILE error (type-level test
// fixture)". Checked by `npm run typecheck` (tsconfig.typecheck.json, #403 — NO exclusions, so a
// `@ts-expect-error` directive inside a `.test.ts` file is REAL, CI-visible enforcement: `npm
// test` runs this file through tsx, which strips types without checking them, so the runtime
// suite never sees this line fail either way, but `npm run typecheck` does, and CI runs both).
// `defineKinds`'s `EventKindTable` constraint requires `meaning`/`actionability` on every kind,
// not just `tags` — a kind object carrying `tags` alone must fail to compile.
// @ts-expect-error — missing `meaning`/`actionability`: a bare `{ tags: [] }` kind must not compile.
defineKinds({ "fixture-kind-missing-glossary": { tags: [] } });

// ── #642: isKnownEventKind / EVENT_KIND_NAMES — `sapwood events --kind` argument validation ──

test("#642 EVENT_KIND_NAMES: exactly the registered kinds, sorted, no duplicates", () => {
  assert.deepEqual([...EVENT_KIND_NAMES].sort(), EVENT_KIND_NAMES, "already sorted");
  assert.deepEqual(new Set(EVENT_KIND_NAMES), new Set(Object.keys(EVENT_KINDS)));
  assert.equal(EVENT_KIND_NAMES.length, Object.keys(EVENT_KINDS).length, "no duplicates");
});

test("#642 isKnownEventKind: true for every registered kind, false for an arbitrary string", () => {
  for (const kind of EVENT_KIND_NAMES) assert.equal(isKnownEventKind(kind), true, kind);
  assert.equal(isKnownEventKind("not-a-real-kind"), false);
  assert.equal(isKnownEventKind(""), false);
  // Object.hasOwn, not `in` — a kind named "toString"/"constructor" must not false-positive off
  // the prototype chain (EVENT_KINDS is a plain object literal, so this is the correct guard).
  assert.equal(isKnownEventKind("constructor"), false);
});
