#!/bin/sh
# run-tests.sh (#786 gate② finding [ac3-sweep-skipped]): runs the engine test suite AND the
# leaked-test-process sweep UNCONDITIONALLY — a failing/timed-out test phase must never skip the
# sweep, since the sweep's whole point is to catch exactly the failure modes (a hung/killed test)
# that leave real processes behind. The overall exit status reflects whichever phase failed,
# preferring the test phase's own status when both failed (it's the more actionable signal).
#
# SAPWOOD_TEST_RUN_ID (#786 gate② finding [ac3-unowned-process-match]): a marker unique to THIS
# invocation, exported so worker.test.ts/dashboard.test.ts can embed it in every tmp dir they
# create, and the sweep script can match ONLY processes carrying it — never a concurrent/unrelated
# process whose argv happens to contain the same generic prefix.
export SAPWOOD_TEST_RUN_ID="run-$$"

node --import tsx --test --test-timeout=60000 "src/**/*.test.ts"
test_status=$?

npx tsx scripts/check-no-leaked-test-processes.ts
sweep_status=$?

if [ "$test_status" -ne 0 ]; then
  exit "$test_status"
fi
exit "$sweep_status"
