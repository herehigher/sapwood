import assert from "node:assert/strict";
import test from "node:test";
import { formatAbsoluteTime, formatRelativeTime, formatRelativeWithAbsoluteTitle } from "./format-time.ts";

// frontend-design.md §7 "Time display" — pinned so the offset math is deterministic
// regardless of the machine running the suite (rule 1: viewer-local via Intl).
process.env.TZ = "Asia/Tokyo";

const ISO = "2026-08-07T05:32:00.000Z"; // 14:32 JST, 05:32 UTC

test("§7 rule 1/3: absolute time renders viewer-local with a UTC-offset label", () => {
  assert.equal(formatAbsoluteTime(ISO, "local"), "14:32 +09:00");
});

test("§7 rule 4: UTC mode renders zero offset, same ISO input", () => {
  assert.equal(formatAbsoluteTime(ISO, "utc"), "05:32 +00:00");
});

test("absolute time never renders a bare wall-clock time (offset always present)", () => {
  for (const mode of ["local", "utc"] as const) {
    assert.match(formatAbsoluteTime(ISO, mode), /^\d{2}:\d{2} [+-]\d{2}:\d{2}$/);
  }
});

test("negative UTC offsets render with a minus sign", () => {
  process.env.TZ = "America/New_York";
  try {
    assert.equal(formatAbsoluteTime(ISO, "local"), "01:32 -04:00"); // EDT, UTC-4 in August
  } finally {
    process.env.TZ = "Asia/Tokyo";
  }
});

test("formatRelativeTime renders compact relative form", () => {
  const now = new Date("2026-08-07T05:32:14.000Z");
  assert.equal(formatRelativeTime(ISO, now), "14s ago");
});

test("§7 rule 2: relative→hover-absolute path uses the same absolute helper", () => {
  const now = new Date("2026-08-07T05:32:14.000Z");
  const { text, title } = formatRelativeWithAbsoluteTitle(ISO, "local", now);
  assert.equal(text, formatRelativeTime(ISO, now));
  assert.equal(title, formatAbsoluteTime(ISO, "local"));
  assert.equal(title, "14:32 +09:00");
});
