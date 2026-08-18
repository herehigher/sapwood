import assert from "node:assert/strict";
import test from "node:test";
import { formatAbsoluteTime, formatCompactAge, formatRelativeTime, formatRelativeWithAbsoluteTitle } from "./format-time.ts";

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

// ── #925 AC4: formatCompactAge — the needs-attention emphasis box's bare-numeral form ─────────

test("formatCompactAge: s/m/h/d unit-boundary thresholds render the correct compact form, one second before and at each boundary", () => {
  const base = "2026-08-07T00:00:00.000Z";
  const at = (deltaSec: number) => new Date(new Date(base).getTime() + deltaSec * 1000);
  const cases: [number, string][] = [
    [0, "0s"], // no elapsed time at all — the empty-fold fallback, never NaN/negative
    [1, "1s"],
    [59, "59s"], // one second below the m boundary
    [60, "1m"], // the m boundary itself
    [3599, "59m"], // one second below the h boundary
    [3600, "1h"], // the h boundary itself
    [86399, "23h"], // one second below the d boundary
    [86400, "1d"], // the d boundary itself
  ];
  for (const [deltaSec, expected] of cases) {
    assert.equal(formatCompactAge(base, at(deltaSec)), expected, `deltaSec=${deltaSec}`);
  }
});

test("formatCompactAge is formatRelativeTime's own compact core, minus the ' ago' suffix — never a second, independently-maintained unit ladder", () => {
  const now = new Date("2026-08-07T05:32:14.000Z");
  assert.equal(formatCompactAge(ISO, now), "14s");
  assert.equal(formatRelativeTime(ISO, now), `${formatCompactAge(ISO, now)} ago`);
});
