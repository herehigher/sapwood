import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { State } from "../state/state.js";
import { type EngineLogger, FileEngineLogger } from "./logger.js";

const NOW = new Date("2026-07-16T01:02:03.004Z");
const tempDir = () => mkdtempSync(join(tmpdir(), "sapwood-logger-"));

test("FileEngineLogger formats one timestamped line and tees the identical record", () => {
  const dir = tempDir();
  const stderr: string[] = [];
  try {
    const path = join(dir, "run.log");
    const logger = new FileEngineLogger({ path, teeToStderr: true, maxBytes: 1024, now: () => NOW, stderr: (line) => stderr.push(line) });
    logger.log("[sapwood:run] started");
    const expected = "[2026-07-16T01:02:03.004Z] [sapwood:run] started\n";
    assert.equal(readFileSync(path, "utf8"), expected);
    assert.deepEqual(stderr, [expected]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileEngineLogger stamps every physical line in a multi-line message", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "run.log");
    const logger = new FileEngineLogger({ path, teeToStderr: false, maxBytes: 1024, now: () => NOW });
    logger.log("[sapwood:role] first\n[sapwood:role] second");
    assert.equal(
      readFileSync(path, "utf8"),
      "[2026-07-16T01:02:03.004Z] [sapwood:role] first\n" + "[2026-07-16T01:02:03.004Z] [sapwood:role] second\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileEngineLogger leaves an under-cap message byte-for-byte untouched", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "run.log");
    const message = `[sapwood:test] ${"x".repeat(8 * 1024 - 100)}`;
    const logger = new FileEngineLogger({ path, teeToStderr: false, maxBytes: 20 * 1024, now: () => NOW });
    logger.log(message);
    assert.equal(readFileSync(path, "utf8"), `[${NOW.toISOString()}] ${message}\n`);
    assert.doesNotMatch(readFileSync(path, "utf8"), /\[truncated \d+ bytes\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileEngineLogger caps an over-limit message at 8 KiB with the exact dropped-byte count", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "run.log");
    const message = `[sapwood:test] ${"x".repeat(10_000)}`;
    const logger = new FileEngineLogger({ path, teeToStderr: false, maxBytes: 20 * 1024, now: () => NOW });
    logger.log(message);
    const record = readFileSync(path, "utf8");
    const boundedMessage = record.slice(`[${NOW.toISOString()}] `.length, -1);
    const match = / … \[truncated (\d+) bytes\]$/.exec(boundedMessage);
    assert.ok(match);
    assert.equal(Buffer.byteLength(boundedMessage), 8 * 1024);
    assert.equal(
      Number(match[1]),
      Buffer.byteLength(message) - Buffer.byteLength(boundedMessage.replace(/ … \[truncated \d+ bytes\]$/, "")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileEngineLogger applies the cap before line splitting and caps the stderr tee", () => {
  const dir = tempDir();
  const stderr: string[] = [];
  try {
    const path = join(dir, "run.log");
    const message = `[sapwood:test] first\n${"y".repeat(10_000)}\nnever-reaches-the-tee`;
    const logger = new FileEngineLogger({
      path,
      teeToStderr: true,
      maxBytes: 20 * 1024,
      now: () => NOW,
      stderr: (line) => stderr.push(line),
    });
    logger.log(message);
    const teeMessage = stderr.map((line) => line.slice(`[${NOW.toISOString()}] `.length, -1)).join("\n");
    assert.equal(Buffer.byteLength(teeMessage), 8 * 1024);
    assert.match(teeMessage, / … \[truncated \d+ bytes\]$/);
    assert.doesNotMatch(teeMessage, /never-reaches-the-tee/);
    assert.equal(readFileSync(path, "utf8"), stderr.join(""));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileEngineLogger omits a trailing-newline phantom record but preserves interior blank lines", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "run.log");
    const logger = new FileEngineLogger({ path, teeToStderr: false, maxBytes: 1024, now: () => NOW });
    logger.log("[sapwood:test] one\n");
    logger.log("[sapwood:test] two\n\n[sapwood:test] three");
    assert.deepEqual(readFileSync(path, "utf8").split("\n").slice(0, -1), [
      `[${NOW.toISOString()}] [sapwood:test] one`,
      `[${NOW.toISOString()}] [sapwood:test] two`,
      `[${NOW.toISOString()}] `,
      `[${NOW.toISOString()}] [sapwood:test] three`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileEngineLogger loops until a sequence of short writes completes the record", () => {
  const dir = tempDir();
  let writes = 0;
  try {
    const path = join(dir, "run.log");
    const logger = new FileEngineLogger({
      path,
      teeToStderr: false,
      maxBytes: 1024,
      now: () => NOW,
      write: (fd, buffer, offset, length) => {
        writes++;
        return writeSync(fd, buffer, offset, Math.min(length, 3));
      },
    });
    logger.log("[sapwood:test] short writes");
    assert.ok(writes > 1);
    assert.equal(readFileSync(path, "utf8"), `[${NOW.toISOString()}] [sapwood:test] short writes\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileEngineLogger rotates current to .1 before crossing maxBytes and keeps no other generations", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "run.log");
    const first = "[2026-07-16T01:02:03.004Z] [sapwood:tick] first\n";
    const second = "[2026-07-16T01:02:03.004Z] [sapwood:tick] second\n";
    const logger = new FileEngineLogger({ path, teeToStderr: false, maxBytes: Buffer.byteLength(first) + 1, now: () => NOW });
    logger.log("[sapwood:tick] first");
    logger.log("[sapwood:tick] second");
    assert.equal(readFileSync(`${path}.1`, "utf8"), first);
    assert.equal(readFileSync(path, "utf8"), second);
    assert.deepEqual(readdirSync(dir).sort(), ["run.log", "run.log.1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileEngineLogger throws clearly when its startup open fails", () => {
  const dir = tempDir();
  try {
    assert.throws(() => new FileEngineLogger({ path: dir, teeToStderr: false, maxBytes: 1024 }), /sapwood run: failed to open log file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileEngineLogger reports a mid-run write failure once, disables file writes, and keeps teeing", () => {
  const dir = tempDir();
  const stderr: string[] = [];
  try {
    const path = join(dir, "run.log");
    const logger = new FileEngineLogger({ path, teeToStderr: true, maxBytes: 100, now: () => NOW, stderr: (line) => stderr.push(line) });
    logger.log("[sapwood:run] initial");
    mkdirSync(`${path}.1`);
    logger.log(`[sapwood:run] ${"x".repeat(100)}`);
    logger.log("[sapwood:run] still visible");
    assert.equal(stderr.filter((line) => line.includes("file logging disabled after write failure")).length, 1);
    assert.ok(stderr.some((line) => line.includes("still visible")));
    assert.ok(readFileSync(path, "utf8").includes("initial"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("narrative logger and structured events ledger remain partitioned", () => {
  const lines: string[] = [];
  const logger: EngineLogger = { log: (message) => lines.push(message) };
  const state = new State(":memory:");
  try {
    logger.log("[sapwood:run] narrative only");
    assert.deepEqual(state.eventsAfterId(0, ["partition-test"]), []);
    state.appendEvent("partition-test", { transition: "durable" });
    assert.deepEqual(lines, ["[sapwood:run] narrative only"]);
    assert.equal(state.eventsAfterId(0, ["partition-test"]).length, 1);
  } finally {
    state.close();
  }
});
