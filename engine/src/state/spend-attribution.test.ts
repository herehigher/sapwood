// #645: a write-site sweep test — the flat-union pattern AC2 asks for. `SpendActorKind` being an
// optional param on recordSpend/settleTerminalWorker (see state.ts's own doc on why it is
// OPTIONAL, not required) means TypeScript alone cannot force every REAL production call site to
// attribute. This test pins the full set: every known call site of `.recordSpend(`/
// `.settleTerminalWorker(` across the three production modules that decide attribution
// (conductor.ts's reclaim path, peripheral.ts's role-session helper, production.ts's engine-review
// verdict) must reference a `SpendActorKind` literal (or the local `actorKind` identifier typed
// as one) somewhere in its own argument list. Adding a NEW call site without attribution — or
// without updating this test's pinned counts — fails loudly, exactly the "a new write site
// without attribution fails" AC.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const ACTOR_KIND_REF = /\bactorKind\b|"worker"|"fix-leg"|"peripheral-role"|"engine-review"/;

/** Every call site of `methodName(` in `source` (a `.methodName(` or `this.methodName(` call —
 *  never the method's OWN declaration, which reads `methodName(` with no leading dot/`this.`),
 *  as the substring from its opening paren to the MATCHING closing paren (brace/paren-depth
 *  tracked, same approach reviewer.test.ts's grep-invariant test already uses for a function
 *  body). */
function callSiteArgSpans(source: string, methodName: string): string[] {
  const spans: string[] = [];
  const callRe = new RegExp(`[.\\w]\\.${methodName}\\(`, "g");
  let m: RegExpExecArray | null = callRe.exec(source);
  while (m !== null) {
    const openIdx = m.index + m[0].length - 1;
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") {
        depth--;
        if (depth === 0) {
          closeIdx = i;
          break;
        }
      }
    }
    assert.ok(closeIdx > openIdx, `${methodName}( at index ${openIdx} in never closes — sweep can't parse this call site`);
    spans.push(source.slice(openIdx, closeIdx + 1));
    m = callRe.exec(source);
  }
  return spans;
}

test("write-site sweep (#645 AC2): every conductor.ts settleTerminalWorker call site attributes actor_kind", () => {
  const source = readFileSync(join(here, "../loop/conductor.ts"), "utf8");
  const spans = callSiteArgSpans(source, "settleTerminalWorker");
  // Pinned: 8 inside reclaimTerminalLane (handoff/driving+fixResponse/done-no-pr/env-requeue/
  // env-preserved/env-rescue/failed-rescue/failed) + 3 in the ordinary RECLAIM DEAD-lane loop +
  // 3 in the FIXING RECLAIM DEAD-lane loop. A count drift here means a call site was added or
  // removed — update this pin ONLY after confirming the new/removed site's attribution is
  // correct, never just to make the test pass.
  assert.equal(spans.length, 14, "settleTerminalWorker call-site count drifted — see this test's own doc before updating the pin");
  for (const span of spans) {
    assert.match(span, ACTOR_KIND_REF, `settleTerminalWorker call site missing actor_kind attribution:\n${span}`);
  }
});

test("write-site sweep (#645 AC2): peripheral.ts's shared role-session recordSpend call site attributes actor_kind + role", () => {
  const source = readFileSync(join(here, "../roles/peripheral.ts"), "utf8");
  const spans = callSiteArgSpans(source, "recordSpend");
  assert.equal(
    spans.length,
    1,
    "peripheral.ts recordSpend call-site count drifted — every role session goes through runSessionWithRetry's ONE shared call",
  );
  assert.match(spans[0]!, /"peripheral-role"/, `peripheral-role call site missing its actor_kind literal:\n${spans[0]}`);
  assert.match(spans[0]!, /roleId/, `peripheral-role call site missing its role (opts.session.roleId):\n${spans[0]}`);
});

test("write-site sweep (#645 AC2): production.ts's decisive engine-review recordSpend call site attributes actor_kind", () => {
  const source = readFileSync(join(here, "../review/production.ts"), "utf8");
  const spans = callSiteArgSpans(source, "recordSpend");
  assert.equal(
    spans.length,
    1,
    "production.ts recordSpend call-site count drifted — #612's decisive-verdict callback is the ONE write site",
  );
  assert.match(spans[0]!, /"engine-review"/, `engine-review call site missing its actor_kind literal:\n${spans[0]}`);
});
