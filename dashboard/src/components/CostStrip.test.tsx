import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CostStrip } from "./CostStrip.tsx";

test("renders one group per bucket with hand-rolled SVG bars", () => {
  const html = renderToStaticMarkup(
    <CostStrip
      groups={[
        {
          title: "by model",
          bars: [
            { label: "opus", usd: 7.8 },
            { label: "sonnet", usd: 2.4 },
          ],
        },
        { title: "by lane", bars: [{ label: "w1", usd: 1.2 }] },
      ]}
    />,
  );
  assert.match(html, /by model/);
  assert.match(html, /by lane/);
  assert.match(html, /<svg/);
  assert.match(html, /\$7\.80/);
  assert.match(html, /\$1\.20/);
});

test("an empty group renders a no-spend caption, not a blank chart", () => {
  const html = renderToStaticMarkup(<CostStrip groups={[{ title: "by model", bars: [] }]} />);
  assert.match(html, /no spend yet today/);
});

test("bar widths are proportional to the group's own max, never overflow 100%", () => {
  const html = renderToStaticMarkup(
    <CostStrip
      groups={[
        {
          title: "by model",
          bars: [
            { label: "opus", usd: 10 },
            { label: "sonnet", usd: 5 },
          ],
        },
      ]}
    />,
  );
  assert.match(html, /width="100"/);
  assert.match(html, /width="50"/);
});
