import assert from "node:assert/strict";
import test from "node:test";
import { modelDisplayName } from "./format.ts";

// #953 AC1: the by-model row's alias — a family word, no per-vendor table beyond the generic
// version-strip + vendor-strip rule (see format.ts's own doc for the algorithm).

test("modelDisplayName: claude-sonnet-5 -> sonnet (strip numeric version, then vendor)", () => {
  assert.equal(modelDisplayName("claude-sonnet-5"), "sonnet");
});

test("modelDisplayName: claude-opus-4-1 -> opus (strip a multi-segment numeric version, then vendor)", () => {
  assert.equal(modelDisplayName("claude-opus-4-1"), "opus");
});

test("modelDisplayName: gpt-5 -> gpt (only one segment survives the version strip, so vendor-strip does not fire)", () => {
  assert.equal(modelDisplayName("gpt-5"), "gpt");
});

test("modelDisplayName: an id with no `-` separator renders verbatim", () => {
  assert.equal(modelDisplayName("localmodel"), "localmodel");
});
