import { useEvents, useLoopState } from "./api/queries.ts";

/**
 * Scaffold shell. The §3 modules (hero, lane board, feed, cost strip, config drawer)
 * land in their own issues; this renders just enough of the §8 payloads to prove the
 * data layer polls and re-renders, and to exercise the §5 tokens.
 */
export function App() {
  const loop = useLoopState();
  const events = useEvents(0);

  return (
    <main className="stack">
      <section className="panel">
        <h1>sapwood</h1>
        {loop.isPending && <p className="muted">connecting…</p>}
        {loop.error && <p style={{ color: "var(--rust)" }}>✕ {loop.error.message}</p>}
        {loop.data && (
          <dl>
            <dt className="muted">engine</dt>
            <dd className="data">{loop.data.engine.state}</dd>
            <dt className="muted">rings</dt>
            <dd className="data">{loop.data.rings}</dd>
            <dt className="muted">lanes</dt>
            <dd className="data">
              {loop.data.lanes.items.length} / {loop.data.lanes.max ?? "?"}
            </dd>
          </dl>
        )}
      </section>

      <section className="panel">
        <h2>feed</h2>
        <ul aria-live="polite">
          {events.data?.events.map((e) => (
            <li key={e.id} className="data">
              {e.ts} {e.kind}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
