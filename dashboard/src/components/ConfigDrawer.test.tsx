import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CONFIG_GROUPS } from "../config-captions.ts";
import { ConfigDrawer } from "./ConfigDrawer.tsx";

const SAMPLE_CONFIG = {
  board: { owner: "herehigher", repo: "sapwood" },
  lanes: { max: 3 },
  worker: { budgetUsdSoft: 5, model: "claude-sonnet-5" },
};

test("renders only the six documented groups, each with its plain-language captions", () => {
  const html = renderToStaticMarkup(<ConfigDrawer config={SAMPLE_CONFIG} open />);
  for (const group of CONFIG_GROUPS) {
    assert.match(html, new RegExp(group.replace("&", "&amp;")));
  }
  assert.match(html, /reaching it asks the worker to wrap up and hand off/);
});

test("only allowlisted keys present in config render — never a raw dump of unknown fields", () => {
  const html = renderToStaticMarkup(<ConfigDrawer config={{ ...SAMPLE_CONFIG, secretToken: "should-never-render" }} open />);
  assert.doesNotMatch(html, /secretToken/);
  assert.doesNotMatch(html, /should-never-render/);
});

test("has no edit affordance anywhere — no input, no editable form control", () => {
  const html = renderToStaticMarkup(<ConfigDrawer config={SAMPLE_CONFIG} open />);
  assert.doesNotMatch(html, /<input/);
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, /<form/);
  assert.doesNotMatch(html, /contenteditable/);
});

test("unreadable config renders the documented placeholder, not an empty drawer", () => {
  const html = renderToStaticMarkup(<ConfigDrawer config={null} open />);
  assert.match(html, /config unreadable/);
});

test("renders nothing when closed", () => {
  const html = renderToStaticMarkup(<ConfigDrawer config={SAMPLE_CONFIG} open={false} />);
  assert.equal(html, "");
});
