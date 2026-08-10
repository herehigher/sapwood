// leak-sweep-matcher.ts (#786 gate② finding [sweep-matcher-untested]) — the core line-matching
// logic engine/scripts/check-no-leaked-test-processes.ts uses to attribute a real `ps` line to a
// leaked test process from THIS run. Pulled out of that script — which lives under
// engine/scripts/, outside this workspace's src-scoped tsconfig.typecheck.json/biome globs, and
// runs only through tsx's type-stripping — so this exact logic gets real static-check and
// unit-test coverage instead of being the one thing that can fail silently (a matcher that never
// matches is indistinguishable from a genuinely clean run).
export function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True iff `line` (one `ps` output row) is a leaked test process attributable to `runId` — either
 *  a worker.test.ts `leaderExitStub` descendant (its own tmp dir embeds `/sapwood-reap-<runId>-`)
 *  or a dashboard.test.ts real dist-server child (its `--db-path` argv embeds
 *  `sapwood-dashboard-cli-<runId>-`, alongside the `dist-server/start.js` entry path). Never a bare
 *  substring match on either family name alone — see this repo's own #786 gate② history for why
 *  that over-matches (a concurrent run, a legitimate dashboard server, or a dispatched worker
 *  session's own argv quoting these exact patterns as prose). */
export function isLeakedSurvivorLine(line: string, runId: string): boolean {
  const runIdPattern = escapeRegExpLiteral(runId);
  const reapSurvivor = new RegExp(`/sapwood-reap-${runIdPattern}-[^/\\s]+/`);
  const dashboardCliDir = new RegExp(`sapwood-dashboard-cli-${runIdPattern}-`);
  const distServerEntry = /dist-server\/start\.js\b/;
  return reapSurvivor.test(line) || (distServerEntry.test(line) && dashboardCliDir.test(line));
}
