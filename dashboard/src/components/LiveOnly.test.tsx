import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveOnly } from "./LiveOnly.tsx";

// AC5: "a test asserts snapshot-backed panels render the 'live only' greyed state whenever the
// data source is replay, regardless of the last-known live value."

test("in live mode, children render through unchanged", () => {
  const html = renderToStaticMarkup(
    <LiveOnly mode="live">
      <span>est $1.23</span>
    </LiveOnly>,
  );
  assert.match(html, /est \$1\.23/);
  assert.doesNotMatch(html, /live only/);
});

test("in replay mode, the 'live only' caption renders and the children never do — even a stale-looking live value must not leak through", () => {
  const html = renderToStaticMarkup(
    <LiveOnly mode="replay">
      <span>est $1.23</span>
    </LiveOnly>,
  );
  assert.match(html, /live only/);
  assert.doesNotMatch(html, /\$1\.23/, "the last-known live value must not render at all in replay, not even greyed");
});

test("replay mode ignores children entirely regardless of what they contain (snapshot-backed panel, arbitrary content)", () => {
  const withStaleData = renderToStaticMarkup(
    <LiveOnly mode="replay">
      <div>
        <h3>config</h3>
        <p>worker.model: opus</p>
      </div>
    </LiveOnly>,
  );
  assert.doesNotMatch(withStaleData, /worker\.model/);
  assert.match(withStaleData, /live only/);
});

test("the live-only caption is an on-panel badge (aria-label), not merely a footnote", () => {
  const html = renderToStaticMarkup(
    <LiveOnly mode="replay">
      <span>anything</span>
    </LiveOnly>,
  );
  assert.match(html, /aria-label="live only"/);
});
