// review/finding-axes.ts (#448, design #402 R1, §0/§1) — two OPTIONAL, ADDITIVE axes on a
// `Finding` (`roles/reviewer.ts`), and the ONE pure function that turns them into the single bit
// the gate actually reads. This module deliberately imports NOTHING from `roles/reviewer.ts`
// beyond the `Finding` type itself — `isFinding`/`validateFindings` stay agent-output.ts's own
// concern — so this file can never become a second place shape-validation logic drifts into.
//
// WHY a module of its own, not folded into agent-output.ts: `Finding & {severity, kind, path}`
// already validates against `roles/reviewer.ts`'s `isFinding`/`validateFindings` TODAY (design
// #402 §0 — they check presence/type of `id`/`body` only, never reject extra keys). That means
// every mechanism below can be built, and unit-tested, without touching a single human-merge-only
// path (`guard/guard.ts`, `guard/guard-hook.ts`, `roles/reviewer.ts`, `roles/merge-driver.ts`) —
// the placement itself is the safety argument (design #402 §0), not an implementation detail.
//
// D2 (owner ruling): `severity` is the ONLY axis that reaches the gate — exactly two states,
// `"blocking"` | `"advisory"`. `kind` and `path` are analysis-only (design #402 §3 convergence,
// §5 tendency); no gate anywhere reads them. A taxonomy edit (adding a `kind`) must never become a
// gate change — `FINDING_KINDS` growing a member is deliberately NOT reachable by
// `effectiveSeverity`'s own logic below.
//
// D3 (owner ruling): the reviewer SESSION may not lower its own gate. `severity: "advisory"` is
// honored ONLY when the finding's `kind` is in `ADVISORY_ELIGIBLE_KINDS` — everything else
// (including an unclassified finding with no `kind` at all) is forced back to `"blocking"` by
// `effectiveSeverity`. This is engine-enforced and prompt-independent: a compromised or careless
// prompt cannot wave through a security defect by mislabeling it.

import type { Finding } from "../roles/reviewer.js";

/** The finite `kind` taxonomy a finding may self-label with (design #402 §1). Analysis-only
 *  (D2) — used by §3 (convergence identity) and §5 (tendency accounting), never by a gate. Growing
 *  this list is a taxonomy edit, not a gate change, BY CONSTRUCTION: `effectiveSeverity` below
 *  reads `severity` and `ADVISORY_ELIGIBLE_KINDS` membership only, never the full set here. */
export const FINDING_KINDS = ["correctness", "security", "design", "test-coverage", "style"] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];

/** The finite `severity` taxonomy (D2 — exactly two states; a gate can only act on two, so two is
 *  the honest cardinality — see design #402 §1's "Rejected alternatives"). */
export type FindingSeverity = "blocking" | "advisory";

/** Every key a finding may carry, post-#448. `agent-output.ts`'s `validateAgentFindings` replaces
 *  its old `Object.keys(f).length !== 2` count check with membership in this set — "the strict-shape
 *  guard is relaxed by allowlist, not by loosening" (design #402 §1): a key outside this set still
 *  voids the WHOLE output, exactly as an extra key did before this issue. */
export const ALLOWED_FINDING_KEYS: ReadonlySet<string> = new Set(["id", "body", "severity", "kind", "path"]);

/** D3's engine-side allowlist: `severity: "advisory"` is honored ONLY for these kinds. An
 *  unclassified finding (`kind` absent) is never advisory-eligible — see the fail-closed defaults
 *  table in design #402 §1. */
export const ADVISORY_ELIGIBLE_KINDS: ReadonlySet<FindingKind> = new Set(["style", "test-coverage"]);

/** A `Finding` extended with the two optional, additive axes (design #402 §1's exact shape). Both
 *  fields are SESSION-supplied inputs, validated by `agent-output.ts` before this type is ever
 *  trusted. The two trailing fields below are ENGINE-RECORDED bookkeeping — never session-supplied
 *  — added by `agent-output.ts`/this module's own helpers when the engine overrides or drops a
 *  session-supplied value; a raw session output never carries them (and `ALLOWED_FINDING_KEYS`
 *  deliberately excludes them from what a session's own JSON may set, since setting `pathDropped`
 *  or `severityOverridden` directly would let a session forge the record it exists to keep
 *  honest). */
export interface ClassifiedFinding extends Finding {
  /** Gate-consuming (D2). Absent ⇒ `"blocking"` (today's exact behavior, see `effectiveSeverity`). */
  severity?: FindingSeverity;
  /** Analysis-only (D2). Absent ⇒ unclassified, which is never advisory-eligible (D3). */
  kind?: FindingKind;
  /** Analysis-only. Target file, validated by the caller to be a member of the reviewed diff's
   *  changed-path set; a path outside that set is dropped to `undefined` (`pathDropped: true`
   *  recorded instead), never trusted as a location the engine did not itself verify. */
  path?: string;
  /** ENGINE-RECORDED (D3): `true` only when this finding requested `severity: "advisory"` but its
   *  `kind` was not in `ADVISORY_ELIGIBLE_KINDS`, so the engine forced it back to `"blocking"`.
   *  Absent on every finding the engine did not override — never `false`, so its mere presence is
   *  itself the record (an auditable trail, design #402 §1's D3 requirement: "the override is
   *  recorded in the persisted review artifact"). */
  severityOverridden?: true;
  /** ENGINE-RECORDED: `true` only when this finding supplied a `path` that turned out not to be a
   *  member of the reviewed diff's changed-path set, so the engine dropped it rather than trust an
   *  unverifiable location (design #402 §1's fail-closed-defaults table). Absent on every finding
   *  whose `path` was absent to begin with, or was verified present in the diff. */
  pathDropped?: true;
}

/**
 * The ONE function that turns a finding's (possibly absent, possibly session-lied-about) axes into
 * the single bit the gate reads (design #402 §1's fail-closed defaults table, D2, D3):
 *
 *  - `severity` absent            ⇒ `"blocking"` (today's exact behavior — a classic-path reviewer
 *                                    or an older prompt that never emits `severity` degrades to no
 *                                    change at all).
 *  - `severity: "blocking"`       ⇒ `"blocking"`, unconditionally.
 *  - `severity: "advisory"` AND
 *    `kind` is in
 *    `ADVISORY_ELIGIBLE_KINDS`    ⇒ `"advisory"`.
 *  - `severity: "advisory"` but
 *    `kind` is absent or NOT in
 *    `ADVISORY_ELIGIBLE_KINDS`    ⇒ `"blocking"` (D3 — the session cannot lower its own gate by
 *                                    mislabeling severity OR by omitting `kind` altogether).
 *
 * Pure — this function alone decides nothing about VOIDING an output (that is
 * `agent-output.ts`'s `validateAgentFindings`, which runs first and rejects an out-of-enum value
 * outright rather than reaching this function at all); by the time a `ClassifiedFinding` reaches
 * here, `severity`/`kind` are guaranteed to be either absent or a valid enum member.
 */
export function effectiveSeverity(f: ClassifiedFinding): FindingSeverity {
  const requested = f.severity ?? "blocking";
  if (requested === "blocking") return "blocking";
  return f.kind !== undefined && ADVISORY_ELIGIBLE_KINDS.has(f.kind) ? "advisory" : "blocking";
}

/**
 * D3's override, applied and RECORDED (design #402 §1: "the override is recorded in the persisted
 * review artifact"). Returns the SAME object reference when no override applies (no new object,
 * no new property — the fail-closed-default byte-for-byte pin, #448 AC#3, depends on this: a
 * finding that never requested `advisory` must round-trip identically). Only when the session
 * requested `"advisory"` and `effectiveSeverity` refused it does this return a NEW object with
 * `severity` forced to `"blocking"` and `severityOverridden: true` set.
 */
export function applySeverityOverride(f: ClassifiedFinding): ClassifiedFinding {
  if (f.severity !== "advisory") return f;
  if (effectiveSeverity(f) === "advisory") return f; // legitimately advisory-eligible — no override
  return { ...f, severity: "blocking", severityOverridden: true };
}

/**
 * `path`, validated against `changedPaths` (design #402 §1's fail-closed-defaults table: "`path`
 * absent, or naming a file not in the reviewed diff | dropped to `null`, recorded"). Returns the
 * SAME object reference when `path` is absent (no bookkeeping needed — never had a location to
 * begin with) or already verified present in `changedPaths`. Only when a `path` was supplied but
 * is NOT a member of `changedPaths` does this return a NEW object with `path` removed and
 * `pathDropped: true` recorded — never a validation failure (design #402 §1: "it does NOT void the
 * output").
 */
export function resolveFindingPath(f: ClassifiedFinding, changedPaths: ReadonlySet<string>): ClassifiedFinding {
  if (f.path === undefined) return f;
  if (changedPaths.has(f.path)) return f;
  const { path: _unused, ...rest } = f;
  return { ...rest, pathDropped: true };
}
