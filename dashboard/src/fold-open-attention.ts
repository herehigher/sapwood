/**
 * #933 AC5's Tier-C probe artifact — the fold script a human operator runs against a real
 * `data/sapwood.sqlite` after an engine round, to verify the needs-attention strip's own
 * contract (EMPTY STRIP = NOTHING IS WAITING ON A HUMAN, frontend-design.md §3) actually holds.
 *
 * Reuses the SAME machinery the browser runs, never a re-implementation: `state.eventsPage`
 * (§8's own `/api/events` transport, `dashboard/server.ts`'s own read path), `toDomainEvent`
 * (the wire→app parse boundary), and `foldOpenAttention` (the strip's fold) — so a pass here is
 * a pass in the running dashboard too, by construction rather than by two implementations
 * agreeing.
 *
 * `npm run fold-open-attention -w dashboard [-- <db-path>]` (default `data/sapwood.sqlite`,
 * `engine/src/state/state.ts`'s own `DEFAULT_DB_PATH`). Read-only open (`{ readOnly: true }`,
 * the same handle `sapwood status` uses) — this script never writes to the ledger it inspects.
 */

// #933: cross-package import, same direction (dashboard -> engine) as `server.ts`'s own
// `new State(opts.dbPath, { readOnly: true })` — the established, safe way this package reads a
// real sqlite ledger; engine never imports back into dashboard.
import { DEFAULT_DB_PATH, State } from "../../engine/src/state/state.ts";
import { toDomainEvent } from "./domain-event.ts";
import { foldOpenAttention } from "./entities.ts";

/** Every ledger event, oldest→newest, paged through `eventsPage` until exhausted — a one-shot
 *  snapshot read (never a live tail), so a plain advancing cursor is correct: an empty page means
 *  nothing after it existed as of this call, full stop. */
function readAllEvents(state: Pick<State, "eventsPage">, pageSize = 5000): ReturnType<State["eventsPage"]> {
  const all: ReturnType<State["eventsPage"]> = [];
  let afterId = 0;
  for (;;) {
    const page = state.eventsPage(afterId, pageSize);
    if (page.length === 0) return all;
    all.push(...page);
    afterId = page[page.length - 1]!.id;
  }
}

/** The strip's own row count for a real DB path — the number AC5 asks a human to record. */
export function countOpenAttention(dbPath: string): { openCount: number; rows: Array<{ kind: string; issue?: number; pr?: number }> } {
  const state = new State(dbPath, { readOnly: true });
  try {
    const events = readAllEvents(state).map((e) => toDomainEvent({ id: e.id, ts: e.ts, kind: e.kind, payload: e.payload as never }));
    const open = foldOpenAttention(events);
    const rows = Object.values(open).map((e) => ({
      kind: e.kind,
      ...(typeof e.payload?.issue === "number" ? { issue: e.payload.issue } : {}),
      ...(typeof e.payload?.pr === "number" ? { pr: e.payload.pr } : {}),
    }));
    return { openCount: rows.length, rows };
  } finally {
    state.close();
  }
}

if (import.meta.filename === process.argv[1]) {
  const dbPath = process.argv[2] ?? DEFAULT_DB_PATH;
  const { openCount, rows } = countOpenAttention(dbPath);
  for (const row of rows) {
    const entity = row.issue !== undefined ? `issue #${row.issue}${row.pr !== undefined ? ` (PR #${row.pr})` : ""}` : "(no issue/PR)";
    console.log(`OPEN  ${row.kind.padEnd(28)} ${entity}`);
  }
  console.log(`\nfold-open-attention: ${dbPath} -> ${openCount} open row(s)`);
  if (openCount > 0) process.exitCode = 1;
}
