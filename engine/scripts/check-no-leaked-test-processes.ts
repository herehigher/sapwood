#!/usr/bin/env -S npx tsx
// check-no-leaked-test-processes.ts (#786) — AC3: an automated, CI-executed sweep of the REAL OS
// process table for the two process families batch-12's close-out sweep found surviving local
// `npm test` runs for days: worker.test.ts's leaderExitStub descendants (each embeds its own
// mkdtemp "sapwood-reap-*" tmp dir in its own command line) and dashboard.test.ts's real
// dashboard/dist-server/start.js child. AC1/AC2's own fixes (worker.test.ts's/dashboard.test.ts's
// own `after()` hooks) already best-effort-clean these in-process; this script is the independent,
// process-table-level verification the issue asks for — invoked by scripts/run-tests.sh
// UNCONDITIONALLY after `node --test`, whether that phase passed, failed, or timed out (#786
// gate② finding [ac3-sweep-skipped]: the sweep's whole point is catching exactly those failure
// modes, so it must never be skipped by a preceding `&&`).
//
// Attribution (#786 gate② finding [ac3-unowned-process-match]): a bare substring match on either
// pattern would also hit an unrelated process — another concurrent test run on a shared CI runner,
// a developer's own separately-running dashboard, or (verified live in this repo's own dogfood
// loop) a dispatched worker session's `claude -p <issue body>` argv, which quotes both patterns
// verbatim as prose examples. `SAPWOOD_TEST_RUN_ID` (set once by run-tests.sh, exported to `node
// --test`) is embedded by worker.test.ts/dashboard.test.ts into every tmp dir they create, which
// in turn shows up in each real spawned process's own command line (a stub script's own path, or
// the `--db-path` argv the dashboard child was launched with) — so `../src/util/leak-sweep-
// matcher.ts` (typechecked/linted/unit-tested, unlike this script itself — see its own doc) matches
// ONLY processes carrying THIS run's marker, never a same-shaped but foreign process. No marker, no
// scan: refuses to run a global, unattributed match rather than silently falling back to one.
//
// #786 gate② finding [sweep-ps-truncation]: `-ww` requests UNBOUNDED command-column width — without
// it, `ps`'s COMMAND field can be silently truncated to (a platform-dependent) terminal width, and
// the one run-id-bearing substring this script can key on sits 180+ characters deep into a real
// leaderExitStub descendant's own command line (the registry-dir write, never run-id-scoped, comes
// first — see leak-sweep-matcher.test.ts's own captured-shape fixtures). A truncated column would
// make `findSurvivors()` return `[]` for a genuinely leaked process FOREVER, with this script still
// printing "clean" — the exact silent-no-op failure mode this finding named. `pid=,command=` (empty
// field names, a convention both BSD and GNU `ps` honor) suppresses the header row too, so there's
// no `.slice(1)` guess about whether one was emitted.
import { execFileSync } from "node:child_process";
import { isLeakedSurvivorLine } from "../src/util/leak-sweep-matcher.js";

const runId = process.env.SAPWOOD_TEST_RUN_ID;
if (!runId) {
  console.error(
    "check-no-leaked-test-processes: SAPWOOD_TEST_RUN_ID is not set — refusing to run an unattributed, global process-table scan. Invoke via `npm test` (engine/scripts/run-tests.sh), which sets it.",
  );
  process.exit(1);
}

function findSurvivors(): string[] {
  // argv array, no shell involved — same discipline as dashboard-launcher.ts's own subprocess calls.
  const output = execFileSync("ps", ["-ww", "-eo", "pid=,command="], { encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => isLeakedSurvivorLine(line, runId));
}

const survivors = findSurvivors();
if (survivors.length > 0) {
  console.error(
    `check-no-leaked-test-processes: ${survivors.length} leaked test process(es) from run ${runId} survived npm test:\n${survivors.join("\n")}`,
  );
  process.exit(1);
}
console.log(`check-no-leaked-test-processes: clean — no sapwood-reap-*/dist-server/start.js survivors attributed to run ${runId}`);
