// #645: a write-site sweep test — the flat-union pattern AC2 asks for. `SpendActorKind` being an
// optional param on recordSpend/settleTerminalWorker (see state.ts's own doc on why it is
// OPTIONAL, not required) means TypeScript alone cannot force every REAL production call site to
// attribute. This test pins the full set.
//
// P2-3 (gate② finding): the ORIGINAL version of this test scanned exactly 3 hard-coded files
// (conductor.ts, roles/peripheral.ts, review/production.ts) — a NEW write site added anywhere
// else under engine/src would pass unnoticed, silently unswept. Fixed the same shape as the
// repo's other grep-invariant pins (#69 spawn-cwd): glob EVERY non-test production `.ts` file
// under `engine/src`, not a file list, so a write site's LOCATION can never be the thing that lets
// it dodge the sweep. `recordEngineReviewVerdictAndSpend` (#645 P1-1) is swept alongside
// `recordSpend`/`settleTerminalWorker` — it is itself a spend-writing call site (it forwards
// straight into `recordSpend` inside one atomic transaction, state.ts's own doc), so a call to it
// without attribution is exactly the same class of bug this sweep exists to catch.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// engine/src — two levels up from engine/src/state/.
const srcRoot = join(here, "..");

const ACTOR_KIND_REF = /\bactorKind\b|"worker"|"fix-leg"|"peripheral-role"|"engine-review"/;

const SPEND_WRITE_METHODS = ["recordSpend", "settleTerminalWorker", "recordEngineReviewVerdictAndSpend"] as const;

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

/** Every non-test production `.ts` file under `dir`, absolute paths — glob, not a hand-maintained
 *  file list (P2-3's own fix). Node 20+'s recursive `readdirSync` walks the whole tree in one
 *  call; `.test.ts` files are excluded (test fixtures are not write sites this sweep governs). */
function productionSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    // Node 24 (this repo's floor, package.json engines) gives Dirent.parentPath.
    out.push(join((entry as { parentPath: string }).parentPath, entry.name));
  }
  return out.sort();
}

test("write-site sweep (#645 P2-3): every recordSpend/settleTerminalWorker/recordEngineReviewVerdictAndSpend call site across ALL of engine/src attributes actor_kind — glob, not a hard-coded file list", () => {
  const files = productionSourceFiles(srcRoot);
  assert.ok(files.length > 50, "sanity: the sweep must actually be walking a nontrivial tree, not an empty/wrong directory");

  const perMethodCounts: Record<string, number> = {};
  for (const method of SPEND_WRITE_METHODS) perMethodCounts[method] = 0;

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const method of SPEND_WRITE_METHODS) {
      for (const span of callSiteArgSpans(source, method)) {
        perMethodCounts[method]!++;
        assert.match(span, ACTOR_KIND_REF, `${method} call site in ${relative(srcRoot, file)} missing actor_kind attribution:\n${span}`);
      }
    }
  }

  // Pinned counts — same "count drift means a site was added/removed, update ONLY after
  // confirming the new/removed site's attribution is correct" discipline the old per-file tests
  // used, now summed over the whole glob instead of 3 file names:
  //   recordSpend: state.ts's own internal forward inside settleTerminalWorker (1) +
  //     recordEngineReviewVerdictAndSpend (1, #645 P1-1) + peripheral.ts's shared role-session
  //     call (1) = 3.
  //   settleTerminalWorker: conductor.ts's reclaimTerminalLane (8) + the ordinary RECLAIM
  //     DEAD-lane loop (3) + the FIXING RECLAIM DEAD-lane loop (3) + round.ts's E-STOP
  //     durable-pid sweep (1, #724 gate② round 3 P1-2) = 15.
  //   recordEngineReviewVerdictAndSpend: production.ts's decisive-verdict callback (1, #645 P1-1
  //     — replaces the old direct recordSpend call that method used to make).
  assert.equal(perMethodCounts.recordSpend, 3, "recordSpend call-site count drifted — see this test's own doc before updating the pin");
  assert.equal(
    perMethodCounts.settleTerminalWorker,
    15,
    "settleTerminalWorker call-site count drifted — see this test's own doc before updating the pin",
  );
  assert.equal(
    perMethodCounts.recordEngineReviewVerdictAndSpend,
    1,
    "recordEngineReviewVerdictAndSpend call-site count drifted — see this test's own doc before updating the pin",
  );
});

test("write-site sweep (#645 AC2): peripheral.ts's shared role-session recordSpend call site attributes actor_kind + role", () => {
  const source = readFileSync(join(srcRoot, "roles", "peripheral.ts"), "utf8");
  const spans = callSiteArgSpans(source, "recordSpend");
  assert.equal(
    spans.length,
    1,
    "peripheral.ts recordSpend call-site count drifted — every role session goes through runSessionWithRetry's ONE shared call",
  );
  assert.match(spans[0]!, /"peripheral-role"/, `peripheral-role call site missing its actor_kind literal:\n${spans[0]}`);
  assert.match(spans[0]!, /roleId/, `peripheral-role call site missing its role (opts.session.roleId):\n${spans[0]}`);
});

test("write-site sweep (#645 P1-1/AC2): production.ts's decisive engine-review recordEngineReviewVerdictAndSpend call site attributes actor_kind", () => {
  const source = readFileSync(join(srcRoot, "review", "production.ts"), "utf8");
  const spans = callSiteArgSpans(source, "recordEngineReviewVerdictAndSpend");
  assert.equal(
    spans.length,
    1,
    "production.ts recordEngineReviewVerdictAndSpend call-site count drifted — #645 P1-1's decisive-verdict-and-spend callback is the ONE write site",
  );
  assert.match(spans[0]!, /"engine-review"/, `engine-review call site missing its actor_kind literal:\n${spans[0]}`);
});
