// cli-root-consistency.test.ts (#1078 AC4): every state-touching CLI command resolves the SAME
// runtime root from the SAME cwd. Split from stop-control.test.ts/park-clear.test.ts/
// events.test.ts (which each pin one command's own behavior) — this file proves the CROSS-
// command consistency claim directly: pause/stop/estop/park clear (mutating) never accept a
// db-path positional any more (a mutable command that could be aimed at dirname(<arbitrary db>)
// would create control files outside the fixed runtime root and outside the guard's root rule);
// status/events (read-only) still do, unchanged.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "../cli.js";
import { DEFAULT_DB_PATH, State } from "../state/state.js";

function withCwd<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-root-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    return fn(dir);
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#1078 AC4: pause/stop/estop/park clear/status/events all resolve the SAME .sapwood/ root from the SAME cwd — no command drifts off to a different data dir", () => {
  withCwd((dir) => {
    const dbPath = join(dir, ".sapwood", "sapwood.sqlite");

    // pause activates against <cwd>/.sapwood — no State constructed yet (ensureRuntimeRoot's own
    // "one mutator that can create a fresh root with no State ever constructed" path, #1077).
    assert.equal(runCli(["node", "sapwood", "pause"]).code, 0);
    const s = new State(dbPath);
    assert.equal(s.isPauseActive(), true, "pause wrote under the SAME .sapwood root status/events will read");
    s.close();

    // status (read-only, no positional given) reads the SAME root and reports the SAME dbPath —
    // the DTO's own dbPath field is the most direct proof two independently-invoked commands
    // agree on which file they mean, not just an indirect "they happen to see the same flag".
    const status = runCli(["node", "sapwood", "status", "--json"]);
    assert.equal(status.code, 0, status.stderr);
    const statusDto = JSON.parse(status.stdout) as { dbPath: string; pauseActive: boolean };
    assert.equal(statusDto.dbPath, DEFAULT_DB_PATH, "status reports the SAME (relative) db path pause/stop/estop resolve to");
    assert.equal(statusDto.pauseActive, true);

    // stop and estop --confirm land in the SAME root too.
    assert.equal(runCli(["node", "sapwood", "stop"]).code, 0);
    assert.equal(runCli(["node", "sapwood", "estop", "--confirm"]).code, 0);
    assert.equal(existsSync(join(dir, ".sapwood", "KILL_SWITCH")), true);
    assert.equal(existsSync(join(dir, ".sapwood", "EMERGENCY_STOP")), true);

    // park clear resolves the SAME root too — no episode is open, but a WRONG root would instead
    // report "no state DB ... engine has never run here", which this must NOT say, since `dbPath`
    // above already created one.
    const park = runCli(["node", "sapwood", "park", "clear"]);
    assert.doesNotMatch(park.stderr, /no state DB/, "park clear found the SAME db pause/stop/estop just used");

    // events (read-only, no positional given) reads the SAME root too — proven with a
    // DISTINCTIVE event inserted into `dbPath` and asserted present in the output, not just a
    // bare exit-0 (events returns 0 even against a MISSING db, so exit code alone would pass
    // even if the positional/root were silently ignored).
    const marker = new State(dbPath);
    marker.appendEvent("run-started", { configHash: "cli-root-consistency-marker" });
    marker.close();
    const events = runCli(["node", "sapwood", "events", "--json"]);
    assert.equal(events.code, 0, events.stderr);
    const eventsDto = JSON.parse(events.stdout) as { dbPath: string; events: { kind: string; payload: unknown }[] };
    assert.equal(eventsDto.dbPath, DEFAULT_DB_PATH, "events reports the SAME (relative) db path every other command resolved");
    assert.ok(
      eventsDto.events.some(
        (e) => e.kind === "run-started" && (e.payload as { configHash?: string }).configHash === "cli-root-consistency-marker",
      ),
      "the marker event written directly into dbPath was read back through events — proving the SAME root, not just a matching exit code",
    );
  });
});

test("#1078 AC4: status/events STILL accept a positional db-path override — read-only commands keep the pre-#1078 escape hatch", () => {
  withCwd((dir) => {
    const elsewhere = join(dir, "elsewhere.sqlite");
    new State(elsewhere).close();
    const status = runCli(["node", "sapwood", "status", elsewhere, "--json"]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal((JSON.parse(status.stdout) as { dbPath: string }).dbPath, elsewhere);

    // Same probative shape as the same-root test above: a distinctive event written into
    // `elsewhere` (never into the default root) must come back — proving the positional
    // actually redirected the read, not merely that the command exited 0.
    const marker = new State(elsewhere);
    marker.appendEvent("run-started", { configHash: "cli-root-consistency-elsewhere-marker" });
    marker.close();
    const events = runCli(["node", "sapwood", "events", elsewhere, "--json"]);
    assert.equal(events.code, 0, events.stderr);
    const eventsDto = JSON.parse(events.stdout) as { dbPath: string; events: { kind: string; payload: unknown }[] };
    assert.equal(eventsDto.dbPath, elsewhere, "events named the intended (positional) path, not the default root");
    assert.ok(
      eventsDto.events.some(
        (e) => e.kind === "run-started" && (e.payload as { configHash?: string }).configHash === "cli-root-consistency-elsewhere-marker",
      ),
      "the marker event written into `elsewhere` was read back — proving the positional actually redirected the read",
    );
  });
});

test("#1078 AC4: pause/stop/estop/park clear REJECT that SAME positional — mutating commands lost the escape hatch status/events keep", () => {
  withCwd((dir) => {
    const elsewhere = join(dir, "elsewhere.sqlite");
    new State(elsewhere).close();
    for (const argv of [
      ["node", "sapwood", "pause", elsewhere],
      ["node", "sapwood", "stop", elsewhere],
      ["node", "sapwood", "estop", elsewhere, "--confirm"],
      ["node", "sapwood", "park", "clear", elsewhere],
    ]) {
      const res = runCli(argv);
      assert.equal(res.code, 1, `${argv.join(" ")} must fail closed`);
      assert.match(res.stderr, /unexpected argument|unknown subcommand/i, `${argv.join(" ")} must name the rejected positional`);
    }
  });
});
