// loop/base-ci.ts (#502): base-branch CI awareness — the engine's RUN-level answer to "is the
// default branch currently red?", and the pin every lane's CI-wait is labelled against.
//
// Why this exists (live dogfood, 2026-08-01, rounds 267+): PRs #493 and #494 were each CI-green
// in isolation, but their COMPOSITION turned main red. From that instant every open PR's merge-ref
// CI inherited the red, and all three in-flight lanes sat in
// `engine-agent: preflight CI-evidence not satisfied` (review/drive.ts) on a 15-minute backoff for
// 1.5h+, with nothing distinguishing "your branch is broken" from "the base is broken" and no
// escalation short of the #426 aging pin's 24h bound. The operator learned it from GitHub, not
// from the engine. A red base is a RUN-level fact that gates every lane at once, and the engine
// had no concept of it at all.
//
// THE PIN IS THE LOG. Exactly the #426 CiPendingPin shape, one level up: no mirror column, no
// in-process clock, no migration — the standing episode is the newest `base-ci-red-observed` that
// no `base-ci-red-cleared` supersedes (`openBaseRedPin` below). A kill between any two writes
// leaves the log authoritative and the next pass simply re-derives, which is the #431 write rule
// applied to a state that has no mirror to get ahead of.
//
// ONE FACT, ONE BIT. There is exactly one default branch, so there is at most one standing pin —
// keyed by the base commit SHA it was observed on. A NEW red commit on the default branch is a
// genuinely new fact and re-pins (and escalates once more); a re-observation of the SAME red
// commit does nothing, no matter how many lanes are waiting or how many times we poll. The
// escalation is therefore bounded by commits landing on main, never by lanes or by polls.
//
// WHO WRITES WHAT. Detection and escalation happen here, driven once per tick from conductor.ts's
// DRIVE section (and only when at least one lane is actually waiting on CI). CLEARING is NOT done
// here: base-green is a resolution, and resolutions belong to the existing escalation-reconcile
// observer (escalation-reconcile.ts's `reconcileBaseCiEscalation`, called from
// `reconcileEscalations`' own once-per-round pass) — one clearing site, receipt before clear, no
// second reconciliation path.
//
// FAIL-CLOSED, AND WHICH DIRECTION. Every ambiguity resolves to NOT-base-red: a forge read that
// throws, a repo with no readable default-branch commit, a rollup with zero contexts. A false
// NEGATIVE degrades to exactly today's behaviour (lanes wait, aged by the #426 pin — the wedge
// this issue names, no worse). A false POSITIVE costs one spurious escalation plus a mislabelled
// wait reason on lanes that are already waiting; nothing in this issue's scope GATES on the pin,
// so it can neither stop a lane nor merge one. Both directions are bounded, and the narrow one is
// still preferred — see this module's PR body for the residual blind spot named honestly rather
// than machined away.
import type { SapwoodConfig } from "../config/config.js";
import type { BranchChecksPage, IForge, PRCheckItem } from "../forge/forge.js";
import type { RequiredCheck } from "../review/ci-evidence.js";
import { requiredChecksRed } from "../review/ci-evidence.js";
import type { State } from "../state/state.js";

/** The base-red episode is OPEN: the default branch's HEAD commit `sha` was observed CI-red. */
export const BASE_CI_RED_OBSERVED = "base-ci-red-observed";
/** The episode is CLOSED — appended by escalation-reconcile.ts STRICTLY AFTER its resolution
 *  receipt (#431's log-first write rule; here the "row" being mirrored is the pin itself). */
export const BASE_CI_RED_CLEARED = "base-ci-red-cleared";
/** The single latched, run-level attention item raised while base-red stands. */
export const BASE_CI_RED_ESCALATED = "base-ci-red-escalated";

/** The standing base-red episode. `failing` is the engine-derived evidence — the failing run
 *  name(s), `name@app` when `ci.requiredChecks` is configured — so the escalation and the
 *  per-lane wait reason can both name WHICH run is red without a second forge read. */
export interface BaseRedPin {
  sha: string;
  at: string;
  failing: string[];
}

/** Conclusions that mean a check RAN and FAILED. Deliberately excludes the concluded-without-
 *  passing set (`SKIPPED`/`NEUTRAL`/`CANCELLED`/`STALE`/`ACTION_REQUIRED`) — those keep a lane
 *  waiting but are not evidence that the base is BROKEN, the same split #426's own
 *  `checkConcludedWithoutPassing` and #503's `requiredChecksRed` already draw. */
const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE"]);
/** A legacy commit StatusContext has no `conclusion` at all — its `state` carries the verdict. */
const FAILED_STATES = new Set(["FAILURE", "ERROR"]);

function concludedFailing(c: PRCheckItem): boolean {
  if (c.conclusion != null) return FAILED_CONCLUSIONS.has(c.conclusion.toUpperCase());
  return c.state != null && FAILED_STATES.has(c.state.toUpperCase());
}

/**
 * Is the default branch's HEAD commit CI-red, and by which run(s)? Empty means NOT base-red —
 * including every no-evidence case (`null` page, no contexts).
 *
 * Two tiers, one rule each, chosen by whether the repo configured `ci.requiredChecks`:
 *  - CONFIGURED -> `requiredChecksRed` verbatim, so base-red binds to the SAME trusted
 *    name+owning-App pairs gate① already trusts. A same-named check from an untrusted app can no
 *    more prove the base red than it can prove a PR green (design #279 §4 R3).
 *  - NOT CONFIGURED -> any check on that commit whose own `conclusion`/`state` field says it ran
 *    and failed. Still an authoritative STRUCTURED signal (GitHub's own verdict field, never
 *    matched text); what it lacks is the ownership binding, which an unconfigured repo has not
 *    supplied. The alternative — reading an empty `requiredChecks` as "never base-red" — would
 *    make this whole feature dead in every repo that has not configured it, including the one
 *    whose live wedge produced the issue.
 */
export function baseCiFailing(page: BranchChecksPage | null, required: readonly RequiredCheck[]): string[] {
  if (page == null) return [];
  if (required.length > 0) return requiredChecksRed(page.checks, required);
  return page.checks
    .filter(concludedFailing)
    .map((c) => c.name)
    .filter((n) => n !== "");
}

/** The standing base-red episode folded out of the durable ledger — latest-wins, exactly like
 *  #426's CI-pending pin. A `base-ci-red-observed` opens; a `base-ci-red-cleared` closes; a NEWER
 *  observation supersedes an older one WITHOUT needing a clear between them (one base branch, one
 *  fact, one bit). A malformed payload is skipped rather than thrown — the same best-effort stance
 *  every other ledger fold in this codebase takes. */
export function openBaseRedPin(events: readonly { kind: string; payload: unknown }[]): BaseRedPin | null {
  let pin: BaseRedPin | null = null;
  for (const e of events) {
    if (e.kind === BASE_CI_RED_CLEARED) {
      pin = null;
      continue;
    }
    if (e.kind !== BASE_CI_RED_OBSERVED) continue;
    const p = (e.payload ?? null) as { sha?: unknown; at?: unknown; failing?: unknown } | null;
    if (typeof p?.sha !== "string" || p.sha === "" || typeof p.at !== "string") continue;
    pin = { sha: p.sha, at: p.at, failing: Array.isArray(p.failing) ? p.failing.filter((f): f is string => typeof f === "string") : [] };
  }
  return pin;
}

/** The QUERYABLE read side (#502): is a base-red episode standing right now, and on which commit?
 *  Deliberately exported and deliberately not write-only — the human-owned `FIXABLE:CI_RED`
 *  suppression check (merge-driver.ts, a human-merge-only path) consumes exactly this to tell a
 *  base-inherited lane failure from a genuine branch-level one. Cheap: the events table is
 *  kind-indexed and a base-red episode appends at most three rows. */
export function baseRedPin(state: Pick<State, "eventsAfterId">): BaseRedPin | null {
  return openBaseRedPin(state.eventsAfterId(0, [BASE_CI_RED_OBSERVED, BASE_CI_RED_CLEARED]));
}

/** The bounded base-branch read, wrapped so no caller has to. `null` means "no usable evidence
 *  this pass" — a thrown read, or a page with no default-branch commit — and every consumer reads
 *  that as NOT-base-red, never as green and never as red. */
export async function readBaseCi(
  forge: Pick<IForge, "getDefaultBranchChecks">,
  cap: number,
  log?: (message: string) => void,
): Promise<BranchChecksPage | null> {
  let page: BranchChecksPage;
  try {
    page = await forge.getDefaultBranchChecks(cap);
  } catch (e) {
    (log ?? console.error)(`[sapwood:base-ci] default-branch check read failed — base CI state unknown this pass: ${String(e)}`);
    return null;
  }
  return page.headOid === "" ? null : page;
}

export interface ObserveBaseCiDeps {
  forge: Pick<IForge, "getDefaultBranchChecks">;
  state: Pick<State, "eventsAfterId" | "appendEvent">;
  cfg: SapwoodConfig;
  now: () => Date;
  log?: (message: string) => void;
}

/**
 * The once-per-tick, run-level observation: read the default branch's checks, and open + escalate
 * a base-red episode if one is not already standing for that exact commit. Returns the pin now in
 * force (possibly the one that was already there), or null when none stands.
 *
 * Never clears — see this module's doc. A pass that produced no usable evidence returns the
 * EXISTING pin untouched: a loop-wide `gh` outage must never read as "the base went green", the
 * same reason #426's CI-pending pin survives a failed pass rather than resetting every lane's
 * clock.
 */
export async function observeBaseCi(deps: ObserveBaseCiDeps): Promise<BaseRedPin | null> {
  const pin = baseRedPin(deps.state);
  const page = await readBaseCi(deps.forge, deps.cfg.proxy.caps.maxChecksPerCall, deps.log);
  if (page == null) return pin;

  const failing = baseCiFailing(page, deps.cfg.ci.requiredChecks);
  if (failing.length === 0) return pin; // green (or no evidence) — resolution is reconcile's job
  if (pin != null && pin.sha === page.headOid) return pin; // LATCHED: same red commit, no re-fire

  const at = deps.now().toISOString();
  const next: BaseRedPin = { sha: page.headOid, at, failing };
  deps.state.appendEvent(BASE_CI_RED_OBSERVED, { sha: next.sha, at, failing, branch: page.branch });
  deps.state.appendEvent(BASE_CI_RED_ESCALATED, { sha: next.sha, failing, branch: page.branch, at });
  (deps.log ?? console.error)(
    `[sapwood:base-ci] the default branch (${page.branch}) is CI-RED at ${next.sha} — failing: ${failing.join(", ")}. ` +
      "Every open lane's merge-ref CI inherits this; lanes will report a base-inherited CI wait until it is fixed.",
  );
  return next;
}
