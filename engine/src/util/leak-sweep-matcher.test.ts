// leak-sweep-matcher.test.ts (#786 gate② finding [sweep-matcher-untested]) — proves the exact
// matching logic engine/scripts/check-no-leaked-test-processes.ts relies on against REAL `ps` line
// shapes (captured from this repo's own worker.test.ts/dashboard.test.ts spawn sites), rather than
// trusting an unchecked, untested script to keep matching correctly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isLeakedSurvivorLine } from "./leak-sweep-matcher.js";

const RUN_ID = "run-38176";
const OTHER_RUN_ID = "run-99999";

// A real worker.test.ts leaderExitStub descendant's own command line: the registry-dir write
// (never run-id-bearing) comes FIRST, and the run-id-bearing descendantReadyFile path — the only
// substring this matcher can key on — starts deep into the string (#786 gate② finding
// [sweep-ps-truncation]'s own point: a `ps` truncation bug would cut exactly this off).
const REAP_LINE = (runId: string) =>
  ` 62027 /Users/gmaster/.nvm/versions/node/v24.18.1/bin/node -e process.on('SIGTERM',()=>{});require('fs').writeFileSync(require('path').join('/var/folders/w_/sq1yf9n53txfm13cc96z6_rm0000gn/T/sapwood-reap-pid-registry-MB90Lk',String(process.pid)),'');require('fs').writeFileSync('/var/folders/w_/sq1yf9n53txfm13cc96z6_rm0000gn/T/sapwood-reap-${runId}-xEyobf/descendant.ready','1');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),600000);`;

// A real dashboard.test.ts dist-server child's own command line.
const DASHBOARD_LINE = (runId: string) =>
  ` 71234 /Users/gmaster/.nvm/versions/node/v24.18.1/bin/node /Users/gmaster/repo/dashboard/dist-server/start.js --db-path /var/folders/w_/sq1yf9n53txfm13cc96z6_rm0000gn/T/sapwood-dashboard-cli-${runId}-Ab12Cd/sapwood.sqlite --port 19955`;

// Only the registry-dir reference (no run-id-bearing descendantReadyFile substring at all) — the
// exact shape finding [sweep-ps-truncation] warns a naive matcher keyed on the registry dir alone
// (never run-id-scoped) would wrongly treat as a match.
const REGISTRY_ONLY_LINE =
  " 62027 /Users/gmaster/.nvm/versions/node/v24.18.1/bin/node -e require('fs').writeFileSync(require('path').join('/var/folders/w_/sq1yf9n53txfm13cc96z6_rm0000gn/T/sapwood-reap-pid-registry-MB90Lk',String(process.pid)),'');";

test("isLeakedSurvivorLine: a real leaderExitStub descendant line, run-id-bearing substring 180+ chars deep, matches its own run", () => {
  assert.equal(isLeakedSurvivorLine(REAP_LINE(RUN_ID), RUN_ID), true);
});

test("isLeakedSurvivorLine: a real dist-server child line matches its own run", () => {
  assert.equal(isLeakedSurvivorLine(DASHBOARD_LINE(RUN_ID), RUN_ID), true);
});

test("isLeakedSurvivorLine: the SAME two shapes carrying a DIFFERENT run id do not match", () => {
  assert.equal(isLeakedSurvivorLine(REAP_LINE(RUN_ID), OTHER_RUN_ID), false);
  assert.equal(isLeakedSurvivorLine(DASHBOARD_LINE(RUN_ID), OTHER_RUN_ID), false);
});

test("isLeakedSurvivorLine: the non-run-scoped sapwood-reap-pid-registry-* marker path alone never matches", () => {
  assert.equal(isLeakedSurvivorLine(REGISTRY_ONLY_LINE, RUN_ID), false);
});

test("isLeakedSurvivorLine: a dist-server entry with no matching run-scoped --db-path does not match — the two conditions are ANDed, not ORed", () => {
  const line = " 1 /usr/bin/node /somewhere/dashboard/dist-server/start.js --db-path /tmp/some-other-unrelated-dir/sapwood.sqlite --port 1";
  assert.equal(isLeakedSurvivorLine(line, RUN_ID), false);
});

test("isLeakedSurvivorLine: a dispatched worker session's own argv quoting these patterns as prose (verified live in this repo's dogfood loop) does not match without the exact run-id substring", () => {
  const line =
    " 68749 claude -p You are an autonomous worker... 3× TERM-immune stubs under $TMPDIR/sapwood-reap-* ... node dashboard/dist-server/start.js --db-path /tmp/static-root-check.sqlite --port 19955";
  assert.equal(isLeakedSurvivorLine(line, RUN_ID), false);
});

test("isLeakedSurvivorLine: a run id containing regex-special characters is treated literally, not as a pattern", () => {
  const weirdRunId = "run-1.2+3";
  const line = ` 1 /usr/bin/node -e x /tmp/sapwood-reap-${weirdRunId}-abc/descendant.ready`;
  assert.equal(isLeakedSurvivorLine(line, weirdRunId), true);
  // "run-1X2+3" (the "." wildcard) must NOT be treated as matching a literal "1.2" run id substring.
  assert.equal(isLeakedSurvivorLine(line, "run-1X2+3"), false);
});
