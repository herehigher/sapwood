// base-ci.ts tests (#502): the run-level base-branch CI signal — the fail-closed derivation, the
// ledger-derived pin fold, the once-per-episode escalation, and the receipt-first clear the
// escalation-reconcile observer performs on base-green. Pure functions plus one `:memory:` State
// and a two-method fake forge — no clock beyond an injected `now`, no timers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { BranchChecksPage, IForge, PRCheckItem } from "../forge/forge.js";
import { UnstubbedForge } from "../forge/unstubbed-forge.test-support.js";
import type { EventKind } from "../state/event-kinds/index.js";
import { State } from "../state/state.js";
import {
  BASE_CI_RED_CLEARED,
  BASE_CI_RED_ESCALATED,
  BASE_CI_RED_OBSERVED,
  baseCiFailing,
  baseRedPin,
  observeBaseCi,
  openBaseRedPin,
} from "./base-ci.js";
import { RESOLVED_KIND, reconcileEscalations } from "./escalation-reconcile.js";

const mkCfg = (requiredChecks?: Array<{ name: string; app?: string }>): SapwoodConfig =>
  ConfigSchema.parse({
    board: { owner: "owner", repo: "r", projectNumber: 1 },
    ...(requiredChecks ? { ci: { requiredChecks } } : {}),
  });

const run = (name: string, conclusion: string | null, appSlug: string | null = "github-actions"): PRCheckItem => ({
  name,
  status: conclusion == null ? "IN_PROGRESS" : "COMPLETED",
  conclusion,
  state: null,
  appSlug,
});

const page = (headOid: string, checks: PRCheckItem[], total?: number): BranchChecksPage => ({
  branch: "main",
  headOid,
  checks,
  total: total ?? checks.length,
});

/** The only two forge members this feature touches. `fail` makes the read throw (the flaky-poll
 *  arm); `result` scripts what a successful read returns. */
class FakeForge extends UnstubbedForge implements IForge {
  result: BranchChecksPage | null = null;
  fail = false;
  reads = 0;
  override async getDefaultBranchChecks(cap: number): Promise<BranchChecksPage> {
    this.reads++;
    assert.ok(cap > 0, "the base-branch checks read must be capped");
    if (this.fail) throw new Error("gh exploded");
    if (this.result == null) throw new Error("no scripted result");
    return this.result;
  }
}

const ev = (kind: EventKind, payload: unknown) => ({ kind, payload });
const observed = (sha: string, at: string, failing: string[]) => ev(BASE_CI_RED_OBSERVED, { sha, at, failing });

const deps = (forge: FakeForge, state: State, cfg: SapwoodConfig, at = "2026-08-01T10:00:00.000Z") => ({
  forge,
  state,
  cfg,
  now: () => new Date(at),
  log: () => {},
});

// ── baseCiFailing: the fail-closed derivation ────────────────────────────────────────────────

test("baseCiFailing: an unreadable / absent page is NOT base-red — fail closed, never an escalation on missing evidence", () => {
  assert.deepEqual(baseCiFailing(null, []), []);
  assert.deepEqual(baseCiFailing(page("a1", []), []), [], "a rollup with zero contexts proves nothing");
});

test("baseCiFailing: with no ci.requiredChecks configured, any CONCLUDED-failing check on the default-branch head is red", () => {
  assert.deepEqual(baseCiFailing(page("a1", [run("test", "FAILURE")]), []), ["test"]);
  assert.deepEqual(baseCiFailing(page("a1", [run("test", "TIMED_OUT")]), []), ["test"]);
  assert.deepEqual(baseCiFailing(page("a1", [run("test", "SUCCESS"), run("lint", null)]), []), [], "green + pending is not red");
  assert.deepEqual(
    baseCiFailing(page("a1", [run("test", "SKIPPED"), run("lint", "NEUTRAL")]), []),
    [],
    "concluded-without-passing is not RED",
  );
});

test("baseCiFailing: with ci.requiredChecks configured, only a trusted required check's FAILURE counts — an untrusted or unrelated red does not", () => {
  const required = [{ name: "test", app: "github-actions" }];
  assert.deepEqual(baseCiFailing(page("a1", [run("test", "FAILURE")]), required), ["test@github-actions"]);
  assert.deepEqual(
    baseCiFailing(page("a1", [run("test", "FAILURE", "rogue-app")]), required),
    [],
    "a same-named check from another app proves nothing",
  );
  assert.deepEqual(baseCiFailing(page("a1", [run("docs", "FAILURE")]), required), [], "a non-required check's red is not base-red");
});

// ── openBaseRedPin: the ledger-derived, restart-safe fold ────────────────────────────────────

test("openBaseRedPin: latest-wins — an observation opens the episode, a clear closes it", () => {
  assert.equal(openBaseRedPin([]), null);
  assert.deepEqual(openBaseRedPin([observed("a1", "2026-08-01T10:00:00.000Z", ["test"])]), {
    sha: "a1",
    at: "2026-08-01T10:00:00.000Z",
    failing: ["test"],
  });
  assert.equal(openBaseRedPin([observed("a1", "2026-08-01T10:00:00.000Z", ["test"]), ev(BASE_CI_RED_CLEARED, { sha: "a1" })]), null);
});

test("openBaseRedPin: a NEW red commit supersedes the standing pin without needing a clear between them — one base branch, one fact, one bit", () => {
  const pin = openBaseRedPin([observed("a1", "2026-08-01T10:00:00.000Z", ["test"]), observed("b2", "2026-08-01T11:00:00.000Z", ["lint"])]);
  assert.deepEqual(pin, { sha: "b2", at: "2026-08-01T11:00:00.000Z", failing: ["lint"] });
});

test("openBaseRedPin: a malformed observation is skipped, never thrown — same best-effort stance every other ledger fold takes", () => {
  assert.equal(openBaseRedPin([ev(BASE_CI_RED_OBSERVED, { at: "x" })]), null, "no sha");
  assert.equal(openBaseRedPin([ev(BASE_CI_RED_OBSERVED, null)]), null);
});

// ── observeBaseCi: detection + the single latched escalation ─────────────────────────────────

test("observeBaseCi: base-red is detected from the new forge read and raises ONE latched escalation naming the base SHA and the failing run", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  forge.result = page("a1c0ffee", [run("test", "FAILURE")]);
  const pin = await observeBaseCi(deps(forge, state, mkCfg()));
  assert.deepEqual(pin, { sha: "a1c0ffee", at: "2026-08-01T10:00:00.000Z", failing: ["test"] });

  const escalations = state.eventsAfterId(0, [BASE_CI_RED_ESCALATED]);
  assert.equal(escalations.length, 1);
  const payload = escalations[0]?.payload as { sha: string; failing: string[] };
  assert.equal(payload.sha, "a1c0ffee", "the escalation names the base commit SHA");
  assert.deepEqual(payload.failing, ["test"], "…and the failing run");
  state.close();
});

test("observeBaseCi: a SECOND detection while base stays red on the same commit creates no duplicate escalation — not per lane, not per poll", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  forge.result = page("a1c0ffee", [run("test", "FAILURE")]);
  await observeBaseCi(deps(forge, state, mkCfg()));
  await observeBaseCi(deps(forge, state, mkCfg(), "2026-08-01T10:15:00.000Z"));
  await observeBaseCi(deps(forge, state, mkCfg(), "2026-08-01T10:30:00.000Z"));
  assert.equal(state.eventsAfterId(0, [BASE_CI_RED_ESCALATED]).length, 1);
  assert.equal(state.eventsAfterId(0, [BASE_CI_RED_OBSERVED]).length, 1);
  state.close();
});

test("observeBaseCi: flaky/partial base evidence fails CLOSED to not-base-red — a throwing read raises no escalation and leaves a standing pin untouched", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  forge.fail = true;
  assert.equal(await observeBaseCi(deps(forge, state, mkCfg())), null);
  assert.equal(state.eventsAfterId(0, [BASE_CI_RED_ESCALATED]).length, 0, "no escalation on unreadable evidence");
  assert.equal(state.eventsAfterId(0, [BASE_CI_RED_OBSERVED]).length, 0);

  // A pin that ALREADY stands must not be cancelled by a failed poll either (a loop-wide gh
  // outage must never look like "the base went green").
  state.appendEvent(BASE_CI_RED_OBSERVED, { sha: "a1", at: "2026-08-01T09:00:00.000Z", failing: ["test"] });
  assert.deepEqual(await observeBaseCi(deps(forge, state, mkCfg())), { sha: "a1", at: "2026-08-01T09:00:00.000Z", failing: ["test"] });
  assert.equal(state.eventsAfterId(0, [BASE_CI_RED_CLEARED]).length, 0);
  state.close();
});

test("observeBaseCi: a green base raises nothing and clears nothing — clearing belongs to the escalation-reconcile observer alone", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  forge.result = page("a1", [run("test", "SUCCESS")]);
  assert.equal(await observeBaseCi(deps(forge, state, mkCfg())), null);
  assert.equal(state.eventsAfterId(0, [BASE_CI_RED_ESCALATED, BASE_CI_RED_OBSERVED, BASE_CI_RED_CLEARED]).length, 0);
  state.close();
});

test("observeBaseCi: a NEW red commit on the default branch is a new fact — it re-pins and escalates once more (bounded by commits to main, never by polls)", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  forge.result = page("a1", [run("test", "FAILURE")]);
  await observeBaseCi(deps(forge, state, mkCfg()));
  forge.result = page("b2", [run("test", "FAILURE")]);
  const pin = await observeBaseCi(deps(forge, state, mkCfg(), "2026-08-01T11:00:00.000Z"));
  assert.equal(pin?.sha, "b2");
  assert.equal(state.eventsAfterId(0, [BASE_CI_RED_ESCALATED]).length, 2);
  state.close();
});

// ── baseRedPin: the queryable read side the human-owned FIXABLE:CI_RED suppression consumes ──

test("baseRedPin (#502 human remainder): the pin's state is queryable by commit SHA — pinned vs. unpinned", () => {
  const state = new State(":memory:");
  assert.equal(baseRedPin(state), null, "unpinned");
  state.appendEvent(BASE_CI_RED_OBSERVED, { sha: "a1c0ffee", at: "2026-08-01T10:00:00.000Z", failing: ["test@github-actions"] });
  assert.deepEqual(baseRedPin(state), { sha: "a1c0ffee", at: "2026-08-01T10:00:00.000Z", failing: ["test@github-actions"] });
  state.appendEvent(BASE_CI_RED_CLEARED, { sha: "a1c0ffee" });
  assert.equal(baseRedPin(state), null, "cleared");
  state.close();
});

// ── the base-green transition, through the existing escalation-reconcile observer ────────────

test("reconcileEscalations (#502): base-green clears the pin RECEIPT-FIRST — the escalation-resolved event is appended strictly before the clear", async () => {
  const state = new State(":memory:");
  const order: string[] = [];
  const spied = new Proxy(state, {
    get(target, prop, receiver) {
      if (prop === "appendEvent") {
        return (kind: EventKind, payload: unknown) => {
          if (kind === RESOLVED_KIND || kind === BASE_CI_RED_CLEARED) order.push(kind);
          target.appendEvent(kind, payload);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as State;

  state.appendEvent(BASE_CI_RED_OBSERVED, { sha: "a1", at: "2026-08-01T10:00:00.000Z", failing: ["test"] });
  state.appendEvent(BASE_CI_RED_ESCALATED, { sha: "a1", failing: ["test"] });
  const forge = new FakeForge();
  forge.result = page("a1", [run("test", "SUCCESS")]);

  await reconcileEscalations(forge, spied, mkCfg(), () => {});

  assert.deepEqual(order, [RESOLVED_KIND, BASE_CI_RED_CLEARED], "receipt before clear (#431 write rule)");
  const resolved = state.eventsAfterId(0, [RESOLVED_KIND]).map((e) => e.payload as { source: string; sha: string; via: string });
  assert.deepEqual(resolved, [{ source: BASE_CI_RED_ESCALATED, sha: "a1", via: "base-green" }]);
  assert.equal(baseRedPin(state), null, "the pin is cleared, so lanes stop reporting a base-inherited wait on their next poll");
  state.close();
});

test("reconcileEscalations (#502): a base that is STILL red leaves the pin standing and appends nothing", async () => {
  const state = new State(":memory:");
  state.appendEvent(BASE_CI_RED_OBSERVED, { sha: "a1", at: "2026-08-01T10:00:00.000Z", failing: ["test"] });
  const forge = new FakeForge();
  forge.result = page("a1", [run("test", "FAILURE")]);
  await reconcileEscalations(forge, state, mkCfg(), () => {});
  assert.equal(state.eventsAfterId(0, [RESOLVED_KIND, BASE_CI_RED_CLEARED]).length, 0);
  assert.deepEqual(baseRedPin(state)?.sha, "a1");
  state.close();
});

test("reconcileEscalations (#502, PR #523 gate② finding 1): main advancing to a DIFFERENT commit that is ALSO red is still red — never a false `base-green` receipt", async () => {
  // The second-broken-push shape: a fix attempt lands on main while the first red still stands,
  // so the default branch's HEAD moves a1 -> b2 and b2 fails too. The base never went green, so
  // nothing here may record that it did — a false `escalation-resolved` witness is durable, and
  // it is exactly the "your evidence says one thing, GitHub says another" ambiguity #502 exists to
  // remove. The pin stays standing on a1 until the next tick's `observeBaseCi` re-pins to b2 (a
  // NEW red commit is a new fact and escalates once more, by design).
  const state = new State(":memory:");
  state.appendEvent(BASE_CI_RED_OBSERVED, { sha: "a1", at: "2026-08-01T10:00:00.000Z", failing: ["test"] });
  state.appendEvent(BASE_CI_RED_ESCALATED, { sha: "a1", failing: ["test"] });
  const forge = new FakeForge();
  forge.result = page("b2", [run("test", "FAILURE")]);
  await reconcileEscalations(forge, state, mkCfg(), () => {});
  assert.equal(state.eventsAfterId(0, [RESOLVED_KIND]).length, 0, "the base is still red — no resolution witness may be recorded");
  assert.equal(state.eventsAfterId(0, [BASE_CI_RED_CLEARED]).length, 0, "…and the pin may not be cleared");
  assert.equal(baseRedPin(state)?.sha, "a1", "the episode stands until the tick re-pins it to the new red commit");
  state.close();
});

test("reconcileEscalations (#502, PR #523 gate② finding 1): main advancing to a DIFFERENT commit that is GREEN resolves normally — the fix must not over-correct into never clearing", async () => {
  const state = new State(":memory:");
  state.appendEvent(BASE_CI_RED_OBSERVED, { sha: "a1", at: "2026-08-01T10:00:00.000Z", failing: ["test"] });
  state.appendEvent(BASE_CI_RED_ESCALATED, { sha: "a1", failing: ["test"] });
  const forge = new FakeForge();
  forge.result = page("b2", [run("test", "SUCCESS")]);
  await reconcileEscalations(forge, state, mkCfg(), () => {});
  const resolved = state.eventsAfterId(0, [RESOLVED_KIND]).map((e) => e.payload as { source: string; sha: string; via: string });
  assert.deepEqual(resolved, [{ source: BASE_CI_RED_ESCALATED, sha: "a1", via: "base-green" }], "the a1 episode is genuinely over");
  const cleared = state.eventsAfterId(0, [BASE_CI_RED_CLEARED]).map((e) => e.payload as { sha: string; head: string });
  assert.deepEqual(cleared, [{ sha: "a1", head: "b2" }], "the clear records WHICH head was observed green, not just which sha was pinned");
  assert.equal(baseRedPin(state), null);
  state.close();
});

test("reconcileEscalations (#502): with NO base-red pin standing, the base-branch read is never made — a resolved episode costs zero forge calls forever after", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  await reconcileEscalations(forge, state, mkCfg(), () => {});
  assert.equal(forge.reads, 0);
  state.close();
});

test("reconcileEscalations (#502): an unreadable base-branch read leaves the episode open this pass — never a false clear", async () => {
  const state = new State(":memory:");
  state.appendEvent(BASE_CI_RED_OBSERVED, { sha: "a1", at: "2026-08-01T10:00:00.000Z", failing: ["test"] });
  const forge = new FakeForge();
  forge.fail = true;
  await reconcileEscalations(forge, state, mkCfg(), () => {});
  assert.equal(state.eventsAfterId(0, [RESOLVED_KIND, BASE_CI_RED_CLEARED]).length, 0);
  assert.equal(baseRedPin(state)?.sha, "a1");
  state.close();
});
