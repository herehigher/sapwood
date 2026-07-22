// review/ci-evidence.ts (#287, E4b, design #279 §4 R3) — the ENGINE (deterministic) half of
// CI execution evidence for the engine-agent drive path. The AGENT (static) half — "does this AC
// map to a named, substantive, non-skipped test on the discovery path" — is prompt-directed
// review, out of this module's scope (design #279 §4.1); this module answers ONLY the
// deterministic question: "does every configured `ci.requiredChecks` entry have a CheckRun on
// the reviewed head, SUCCESS, whose check suite belongs to the configured GitHub App."
//
// SKIPPED / NEUTRAL / a legacy commit StatusContext / a same-named check from a DIFFERENT app all
// fail this — see requiredChecksSatisfied's own doc for exactly why each shape is rejected.

import type { PRCheckItem } from "../forge/forge.js";

export interface RequiredCheck {
  name: string;
  app: string;
}

export interface RequiredChecksResult {
  ok: boolean;
  /** `"name@app"` for every configured entry that found no matching, trusted, SUCCESS CheckRun —
   *  empty when `ok` is true. Also carries a single synthetic entry when `required` itself is
   *  empty (see the doc below) so a caller never has to special-case an empty reason list. */
  unsatisfied: string[];
}

/**
 * design #279 §4's deterministic CI-evidence chain, item 2 + 3:
 *
 *  - Item 2: every `required` entry must have a matching `checks` entry with the SAME `name`,
 *    the SAME `appSlug` (the check suite's owning GitHub App — a same-named check from an
 *    UNTRUSTED app is not evidence, R3), and `conclusion === "SUCCESS"`. `SKIPPED`/`NEUTRAL`
 *    (completed but non-SUCCESS conclusions) and a `null` conclusion (queued/in-progress) all
 *    fail to match — this function only ever counts a conclusively PASSING run. A legacy commit
 *    StatusContext entry (`PRCheckItem.state` set, `conclusion` null, `appSlug` always null/
 *    undefined — no check-suite/App concept exists for that shape) can never match either: its
 *    `appSlug` is never equal to a configured `app` string, so it fails the ownership half
 *    unconditionally (design #279 §4: "SKIPPED/NEUTRAL/legacy-status-context DO NOT satisfy it").
 *  - Item 3: an EMPTY `required` list can never be satisfied — "code-verifiable AC can at best be
 *    claim-based (fail-closed: no trusted execution evidence exists)". Returned as `ok: false`
 *    with an explanatory synthetic `unsatisfied` entry (config.ts's own parse-time warning covers
 *    the "you probably meant to configure this" nudge; this is the RUNTIME fail-closed half —
 *    review/drive.ts's preflight step reads `ok` alone and queues, never a paid session, exactly
 *    like every other preflight gate failure).
 */
export function requiredChecksSatisfied(checks: readonly PRCheckItem[], required: readonly RequiredCheck[]): RequiredChecksResult {
  if (required.length === 0) {
    return {
      ok: false,
      unsatisfied: ["ci.requiredChecks is empty — no trusted execution evidence is configured (fail-closed, design #279 §4.3)"],
    };
  }
  const unsatisfied: string[] = [];
  for (const req of required) {
    const match = checks.some((c) => c.name === req.name && c.conclusion === "SUCCESS" && (c.appSlug ?? null) === req.app);
    if (!match) unsatisfied.push(`${req.name}@${req.app}`);
  }
  return { ok: unsatisfied.length === 0, unsatisfied };
}
