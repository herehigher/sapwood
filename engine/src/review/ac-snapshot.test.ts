// ac-snapshot.test.ts (#283, design #279 §5) — pure unit coverage for the AC-authority
// dispatch snapshot: hashBody/buildAcSnapshot/checkAcSnapshotDrift. Integration coverage
// (persist-before-spawn, review-time drift -> needsHuman, snapshotted body survives a
// mid-flight live edit) lives in conductor.test.ts, against the real DISPATCH/DRIVE loops.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAcSnapshot, checkAcSnapshotDrift, hashBody, hashBodyForAcAuthority } from "./ac-snapshot.js";

test("hashBody: deterministic and content-sensitive", () => {
  assert.equal(hashBody("hello"), hashBody("hello"));
  assert.notEqual(hashBody("hello"), hashBody("hello!"));
});

test("buildAcSnapshot: records the full body, its hash, and the extracted AC manifest", () => {
  const body = "## Acceptance criteria\n\n- [ ] one\n- [ ] two\n\n## Verification\nrun tests";
  const snap = buildAcSnapshot(7, body, "2026-07-21T00:00:00Z");
  assert.equal(snap.issue, 7);
  assert.equal(snap.body, body);
  assert.equal(snap.bodyHash, hashBody(body));
  assert.equal(snap.snapshottedAt, "2026-07-21T00:00:00Z");
  assert.deepEqual(
    snap.manifest.map((m) => m.text),
    ["one", "two"],
  );
});

test("buildAcSnapshot: an issue with no checkbox AC (e.g. verify:n/a) snapshots an EMPTY manifest, never throws", () => {
  const snap = buildAcSnapshot(9, "no plan needed", "t0");
  assert.deepEqual(snap.manifest, []);
  assert.equal(snap.body, "no plan needed");
});

test("buildAcSnapshot: an undefined/empty body snapshots cleanly (never throws)", () => {
  const snap = buildAcSnapshot(1, "", "t0");
  assert.equal(snap.body, "");
  assert.deepEqual(snap.manifest, []);
  assert.equal(snap.bodyHash, hashBody(""));
});

test("checkAcSnapshotDrift: identical live body -> ok, and the returned body/manifest are the SNAPSHOTTED values (never the live argument)", () => {
  const body = "## Acceptance criteria\n\n- [ ] one";
  const snap = buildAcSnapshot(1, body, "t0");
  const result = checkAcSnapshotDrift(body, snap);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.body, snap.body);
    assert.deepEqual(result.manifest, snap.manifest);
  }
});

test("checkAcSnapshotDrift: ANY body change (not just inside the AC section) is drift — R3's full-body widening", () => {
  const snap = buildAcSnapshot(1, "## Acceptance criteria\n\n- [ ] one\n\n## Verification\nrun tests", "t0");
  // Only the verification section changed — the AC lines are byte-identical.
  const liveBody = "## Acceptance criteria\n\n- [ ] one\n\n## Verification\nrun the WHOLE suite instead";
  const result = checkAcSnapshotDrift(liveBody, snap);
  assert.equal(result.ok, false);
});

test("checkAcSnapshotDrift: a mid-flight AC edit is drift, and the failure reason names both hashes (no silent re-extraction)", () => {
  const snap = buildAcSnapshot(1, "## Acceptance criteria\n\n- [ ] one", "t0");
  const result = checkAcSnapshotDrift("## Acceptance criteria\n\n- [ ] one EDITED", snap);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /snapshotted [0-9a-f]{12}, live [0-9a-f]{12}/);
  }
});

// ── #752: hashBodyForAcAuthority — marker-normalized AC-authority hash ──────────────────────────

test("hashBodyForAcAuthority: a marker-line-only diff (the cursor advancing) hashes IDENTICALLY", () => {
  const withMarker0 = "## Acceptance criteria\n\n- [ ] one\n\n<!-- sapwood:comments-adjudicated-through: 0 -->";
  const withMarkerAdvanced = "## Acceptance criteria\n\n- [ ] one\n\n<!-- sapwood:comments-adjudicated-through: 5236875925 -->";
  assert.equal(hashBodyForAcAuthority(withMarker0), hashBodyForAcAuthority(withMarkerAdvanced));
});

test("hashBodyForAcAuthority: a real (non-marker) diff still hashes DIFFERENTLY, marker held fixed", () => {
  const a = "## Acceptance criteria\n\n- [ ] one\n\n<!-- sapwood:comments-adjudicated-through: 5 -->";
  const b = "## Acceptance criteria\n\n- [ ] one EDITED\n\n<!-- sapwood:comments-adjudicated-through: 5 -->";
  assert.notEqual(hashBodyForAcAuthority(a), hashBodyForAcAuthority(b));
});

test("hashBodyForAcAuthority: a marker advance PLUS a real edit still hashes differently from the original (real edit isn't masked)", () => {
  const original = "## Acceptance criteria\n\n- [ ] one\n\n<!-- sapwood:comments-adjudicated-through: 0 -->";
  const markerPlusRealEdit = "## Acceptance criteria\n\n- [ ] one EDITED\n\n<!-- sapwood:comments-adjudicated-through: 5 -->";
  assert.notEqual(hashBodyForAcAuthority(original), hashBodyForAcAuthority(markerPlusRealEdit));
});

test("hashBodyForAcAuthority: unlike hashBody, differs from hashBody's own output when a marker is present", () => {
  const body = "## Acceptance criteria\n\n- [ ] one\n\n<!-- sapwood:comments-adjudicated-through: 5 -->";
  assert.notEqual(hashBodyForAcAuthority(body), hashBody(body));
});

test("checkAcSnapshotDrift: a live body that ONLY advances the cursor marker since dispatch is NOT drift", () => {
  const dispatchBody = "## Acceptance criteria\n\n- [ ] one\n\n<!-- sapwood:comments-adjudicated-through: 0 -->";
  const snap = buildAcSnapshot(1, dispatchBody, "t0");
  const liveBody = "## Acceptance criteria\n\n- [ ] one\n\n<!-- sapwood:comments-adjudicated-through: 5236875925 -->";
  const result = checkAcSnapshotDrift(liveBody, snap);
  assert.equal(result.ok, true);
});

test("checkAcSnapshotDrift: a marker advance PLUS a real body edit still fails closed (real edit isn't masked by normalization)", () => {
  const dispatchBody = "## Acceptance criteria\n\n- [ ] one\n\n<!-- sapwood:comments-adjudicated-through: 0 -->";
  const snap = buildAcSnapshot(1, dispatchBody, "t0");
  const liveBody = "## Acceptance criteria\n\n- [ ] one EDITED\n\n<!-- sapwood:comments-adjudicated-through: 5236875925 -->";
  const result = checkAcSnapshotDrift(liveBody, snap);
  assert.equal(result.ok, false);
});
