# #355 — machine-consumed worker refusal signal (design pass)

Design-review record for issue #355. Design-only issue (verification plan: "Design-review
path") — no code change ships from this issue itself; the decision below is carried into a
separate implementation issue, filed with its own AC/verification.

## Finding: does a no-PR worker stop reach a human today, with its reason attached?

Traced the actual outcome→escalation path, not the intended one.

**A coding worker legitimately holds real forge credentials** (`docs/security.md`: "Code-producing
worker lanes are unaffected: they legitimately hold the token, mediated by the guard hook") and
`gh issue comment`/`create`/`view`/`list`/`status` are explicitly allowed through `guard.ts` —
`docs/security.md` names this outright: *"comment is the worker's refuse/hand-back channel."* So a
worker that judges an issue unworkable (contradictory AC, a referenced file that doesn't exist) can
genuinely post its reasoning as a plain issue comment and exit without opening a PR. That much
works exactly as designed.

**The engine's escalation, however, is derived purely from the OUTCOME, never from that text.**
`conductor.ts`'s `reclaimTerminalLane`, the DONE branch, `next === laneOnReclaimDone(p.hasPr)`:

```ts
} else {
  // ESCALATE_NOPR: done but no PR -> nothing to drive; free the lane, escalate to human.
  state.settleTerminalWorker(
    { ...w, state: "done", ended_at: doneAt },
    { worker: w.name, issue: w.issue, usd: costUsd, at: doneAt, models: modelUsage },
  );
  await forge.addLabel(w.issue, cfg.labels.needsHuman);
}
state.appendEvent("reclaim-done", { worker: w.name, issue: w.issue, next, ...prTitlePayload(p) });
```

That's the entire escalation: one label add, one event with `{worker, issue, next}`. No comment
read, no reason field, nothing that connects to whatever text the worker may have posted. The
`FAILED`-with-no-PR path (`laneOnReclaimFailed`, same file) and the fix-round-cap/verdict-rerun
escalations (`~conductor.ts:4380-4423`) share the identical shape: label(s) added, a *derived*
reason string composed by the engine from its own bookkeeping (rounds spent, cap, verdict id) —
never the worker's own stated words.

**The reason text is not actually lost — it's already parsed and then discarded.**
`worker.ts`'s `LaneProbe` construction sets `resultText` unconditionally for every DONE lane
(`const resultText = done ? this.terminalResultText(name) : undefined;` — not gated on `hasPr`),
via `parseResultText()`, the same primitive #110's structured-output roles use. `conductor.ts`
reads `p.resultText` in exactly one place: the `next === "DRIVING"` branch (`w.state === "fixing"`,
i.e. only for a fix leg that already has a PR), to build `fixResponse`. The `ESCALATE_NOPR` branch
five lines below never touches `p.resultText` at all — it is sitting on the same `p` object,
already parsed, and is simply not read.

**Net finding:** a no-PR worker stop does reach a human — GitHub notifies on `needs-human`, and
the label is real. But the WORKER'S REASON reaches a human only by accident, only if they happen to
open the issue and scroll to find the worker's comment (if one was even posted — nothing requires
it), and never in any form the engine itself can query, log, or act on. The #353 framing
("human-readable but not machine-consumed", "the reason and the escalation are decoupled") is
accurate and current, verified against today's `conductor.ts`/`worker.ts`, not stale.

## Decision

**Accept a signal — but the minimal one, not a new structured-output schema.**

The candidate directions from the issue body, weighed:

- *A recognized worker-output structured block (#110-style), engine-parsed and validated.*
  Rejected as more machinery than the gap needs. #110's structured-output paradigm exists because
  those roles' output must be **validated and acted on differently per shape** (PO triage decisions,
  harvest outcomes, fix-response resolutions each drive distinct engine branches). A refusal reason
  drives no branch — the AC only asks "does the reason reach a human," not "can the engine route
  differently by refusal category." A schema would add a validator, a fail-closed-invalid path, and
  a worker-facing contract to teach, all to carry a string the engine already has parsed.
- *A sentinel-file/marker-comment convention.* Also unnecessary for the same reason, and it
  duplicates a channel that already exists — `p.resultText` is the worker's final message,
  captured today with zero new machinery.
- **Adopted: surface `p.resultText` (already parsed, zero new capability) as the escalation's
  reason, engine-executed, on the SAME no-PR escalation paths that exist today.** Concretely: at
  the `ESCALATE_NOPR` site (and the mirror `FAILED`-no-PR site), when `p.resultText` is non-empty,
  attach a capped excerpt as (a) a field on the `reclaim-done`/failed event payload (durable,
  queryable — closes the "not machine-consumed" half) and (b) an engine-authored
  `forge.addIssueComment` posted alongside the `needs-human` label add (visible where the human is
  already looking — closes the "reason and escalation are decoupled" half). This is the exact
  label+comment, engine-authored, both-durable-before-terminal-write pattern already proven at the
  fix-rounds-cap escalation (`conductor.ts:~4392-4423`) — no new pattern, an existing one applied to
  a path that never adopted it.

**Naming the tradeoff (per this repo's own authoritative-signals-over-inferred-text doctrine):**
this is deliberately raw text, not a validated signal — the engine is not classifying or acting on
the *content* of the reason, only re-surfacing verbatim text it already possesses, the same
"evidence, not a verdict" stance `worker.ts`'s egress-suspect `snippet` field already takes. Because
nothing downstream branches on the string's shape, the free-text-is-last-resort caution (which
governs *detection/classification*) does not apply here — there is no detection happening, only
transport of a fact the worker already stated and the engine already parsed.

## Non-goal

**No new worker forge-write capability.** The worker's optional `gh issue comment` stays exactly
as it is today — real credential, mediated by `guard.ts`, unchanged, still the worker's own choice
whether to post one. The fix is entirely on the READ side (the engine already parses
`p.resultText`) and the WRITE side (the engine already posts issue comments and adds labels with
its own credentials, e.g. the fix-rounds-cap escalation). Nothing here asks the worker to write
anything it cannot write today, and nothing here removes `#110`/`#352`/`#353`'s containment of
credential-free peripheral/fix roles.

## Implementation issue

Filed as a follow-up with its own acceptance criteria and verification plan (TDD: red test proving
`ESCALATE_NOPR`'s `reclaim-done` event and escalation comment carry no reason today, green after
the change): **[#601](https://github.com/herehigher/sapwood/issues/601)** — see that issue for
AC/verification detail. Not implemented here; this issue's own verification plan is design-review
only.
