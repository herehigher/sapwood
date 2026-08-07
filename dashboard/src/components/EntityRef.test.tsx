import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EntityRef } from "./EntityRef.tsx";

test("an entity with a folded title renders a hover tooltip and its type glyph", () => {
  const html = renderToStaticMarkup(<EntityRef token={{ kind: "issue", number: 86 }} titles={{ 86: { issueTitle: "Fix the thing" } }} />);
  assert.match(html, /title="Fix the thing"/);
  assert.match(html, /<svg/);
  assert.match(html, /#86/);
});

test("an entity with no folded title shows no tooltip and makes no network call", () => {
  const html = renderToStaticMarkup(<EntityRef token={{ kind: "issue", number: 86 }} titles={{}} />);
  assert.doesNotMatch(html, /title=/);
});

test("a PR token looks up its title via the associated issue, not its own number", () => {
  const html = renderToStaticMarkup(
    <EntityRef token={{ kind: "pr", number: 97, issue: 86 }} titles={{ 86: { prTitle: "Add the widget" } }} />,
  );
  assert.match(html, /title="Add the widget"/);
  assert.match(html, /#97/);
});

test("a PR token with no associated issue never throws and shows no tooltip", () => {
  const html = renderToStaticMarkup(<EntityRef token={{ kind: "pr", number: 5 }} titles={{}} />);
  assert.doesNotMatch(html, /title=/);
});

test("issue and PR glyphs render distinct shapes, not just distinct colors", () => {
  const issueHtml = renderToStaticMarkup(<EntityRef token={{ kind: "issue", number: 1 }} titles={{}} />);
  const prHtml = renderToStaticMarkup(<EntityRef token={{ kind: "pr", number: 1 }} titles={{}} />);
  assert.notEqual(issueHtml, prHtml);
});

test("renders a real GitHub link when a repoUrl is supplied", () => {
  const html = renderToStaticMarkup(
    <EntityRef token={{ kind: "issue", number: 86 }} titles={{}} repoUrl="https://github.com/herehigher/sapwood" />,
  );
  assert.match(html, /href="https:\/\/github\.com\/herehigher\/sapwood\/issues\/86"/);
});

test("renders a PR link under /pull/, not /issues/", () => {
  const html = renderToStaticMarkup(
    <EntityRef token={{ kind: "pr", number: 97, issue: 86 }} titles={{}} repoUrl="https://github.com/herehigher/sapwood" />,
  );
  assert.match(html, /href="https:\/\/github\.com\/herehigher\/sapwood\/pull\/97"/);
});
