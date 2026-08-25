# Design — issues-only role session derivations (2026-08)

> **Process record.** Internal design/research artifact from sapwood's own development
> history — not end-user documentation. Read current docs/code for shipped state:
> [`../security/role-sessions.md`](../security/role-sessions.md) is the mechanism reference this
> record was split out of (#1094 PR-2, compressing "Worker denylist vs. peripheral allowlist" and
> "Issues-only role sessions"). This document preserves the rationale, measurements, and rejected
> alternatives behind decisions the current page states only as accepted blind spots and
> enforcement boundaries.

## Origin: "Issues-only role sessions" — the worker's spawn-capability decision and its cost measurement

The current page keeps only the ruling itself ("the code-producing worker deliberately retains
spawn capability" — `worker.ts::WORKER_DISALLOWED_TOOLS` does not deny `Agent`/`Task`) and the
accepted-blind-spot statement. The reasoning and the live measurement that grounded it follow,
verbatim from the pre-compression page:

---

**The worker's decision, and why it differs from the peripheral-role deny above, honestly stated.**
That earlier deny
cost nothing — a peripheral role's observed spawn was pure circumvention of its own deliberate
lack of a shell, zero legitimate benefit. Subagent use is a mainline coding capability for the
worker (parallel sub-reads on a large refactor), so denying it has a real cost, and the
separation-of-duties boundary holds regardless of the answer: the guard hook rides in via
`--settings` and its PreToolUse fires on a child's tool calls too, so `WORKER_DISALLOWED_TOOLS`'
merge/approve/ready/label/project denies are inherited by anything a worker spawns. This was
never a producer≠merger hole; it is a soft-budget accounting question, decided as follows:
**keep spawn enabled, and accept the soft-budget overshoot it opens as a documented, unbounded
blind spot** — no new poll-tightening or child-cost-accounting machinery, per this repo's
marginal-complexity rule (`docs/PLAN.md`), because a live measurement (below) shows the overshoot
is small relative to a worker leg's own budget, not because the blind spot is bounded by any code
in this engine.

The concrete mechanism: `checkSoftBudget()`/`liveTelemetry()` (`worker.ts`) re-derive the running
spend estimate by re-parsing **one file**, `lane.jsonlPath` — the parent session's own
stream-json transcript. Claude Code's CLI writes a spawned subagent's entire turn history
(its own `assistant`/`user`/`tool_use` lines, token usage included) to a **separate** file —
observed on disk as `<parent-session-dir>/subagents/agent-<id>.jsonl` — that neither
`checkSoftBudget` nor `liveTelemetry` ever reads. The parent's own jsonl gains exactly one small
`assistant` entry for the turn where it issues the `Agent`/`Task` tool call, and one more once the
tool result returns; every token the child itself spent in between is structurally invisible to
the live estimator for the child's entire lifetime — not a one-poll delay, a complete gap bounded
only by how long the child runs.

**Live measurement:** one real subagent call (`Explore`
agent type, a research task comparable to ordinary worker sub-reads) spent 30 input + 1,268
output + 125,616 cache-creation + 384,230 cache-read tokens over ~37.5 wall-clock seconds
(15 of its own `assistant` turns) — roughly **$0.61** at this repo's shipped `sonnet` rate
(`engine/pricing.yaml`). The parent's own jsonl recorded the dispatching tool_use at T+0 and the
next line — the tool_result, once the child fully finished — 43 seconds later: zero new assistant
lines from the parent in between, the entire 37.5s child run included.
Against the dogfooded `opus`/`high` worker-leg soft budget of $8–20 (`docs/guide/configuration.md`),
one subagent call is roughly 3–8% of the whole per-leg budget — small enough that
accepting it unbounded, rather than building accounting for it, is the marginal-complexity call.

**Stated honestly, not overclaimed:** this measurement covers ONE sequential subagent call. A
worker that fans out several/many children concurrently (the CLI has no cap sapwood imposes) can
accumulate a correspondingly larger invisible total — nothing in this engine bounds that other
than the worker's own prompted behavior, which today does not direct large fan-outs. The existing
`egress-suspect` event (`worker.ts`) already logs every `Agent`/`Task` tool_use a worker
leg makes, but for network-egress containment, not cost — it is not a cost-accounting signal and
this decision does not lean on it as one. If a future dogfood round measures a worker leg whose
subagent fan-out meaningfully erodes the soft budget's purpose (frequent late handoffs, or spend
well past `budgetUsdSoft` before the next graceful SIGTERM), that is the trigger to revisit this
as a bounding problem (tighter `heartbeatMs`, or summing `subagents/*.jsonl` into
`liveTelemetry()`) — not a reason to have built that machinery pre-emptively today.

---

## Origin: "The forge MCP proxy's role x tool matrix" — the ten-role grant is deliberate

The current page states the matrix's shape and its enforcement/test citations only. The argument
against narrowing it on zero-call evidence, verbatim:

---

**This ten-role grant is deliberate, not an oversight to narrow.** Every one of these tools is
read-only and costs nothing when a session never calls it, and a measured zero-call count is not
evidence that a grant is unneeded: zero calls means the role's TASK never asked for a
lookup, not that the capability itself has no use — the lever for changing that is the task step
a prompt gives the role, not the grant it holds.

---

## Origin: "HONEST SCOPE — this is NOT full isolation" — the steal.mjs proof-of-concept and rejected mitigations

The current page keeps the residual statement itself (workerCredentialFreeEnv + the MCP seal do
not structurally confine what a fix leg's `Bash(node *)`/`Bash(npm *)` grant can read off disk)
and the accepted upgrade path (OS-level sandboxing / a dedicated CI identity). The proof-of-concept
that confirmed the residual, and the two mitigations considered and rejected, verbatim:

---

A live proof-of-concept (`node steal.mjs`, a script invoked through exactly that grant) read
`~/.config/gh/hosts.yml` directly and reached GitHub with the credential found there, bypassing
every env var `workerCredentialFreeEnv` touches entirely — filesystem access is orthogonal to
environment-variable redirection AND to the MCP seal, and no amount of either closes it. Two
mitigations this repo deliberately does NOT attempt: **HOME isolation** (redirecting `$HOME` would
break the `claude` CLI's own config/auth, which the lane also needs merely to run) and **stripping
`Bash(node *)`/`Bash(npm *)`** (a fix leg's whole job requires running tests).

---

## Origin: "Worker-leg user-settings persistence vector" — arms considered and rejected

The current page keeps what shipped (detect-and-disclose via `createUserSettingsWatch`) and the
residual. The two other arms weighed and rejected for this specific vector, verbatim:

---

Two other arms were considered and rejected for this specific vector:

- **Arm (1), pinning `--setting-sources` on worker legs** — ruled out. A prior measurement already
  found that `--setting-sources ""` also stops the repo's own `CLAUDE.md` from loading, which
  collides with the locked ruling below ("ambient repo context: record, don't seal"). A partial
  source list (e.g. `"project,local"`) is unproven and carries a named `apiKeyHelper`-breakage
  risk on hosts whose Claude auth lives in user settings — config-gating that would add a new
  config key and a host-compatibility matrix for a vector the L1 direction (worker =
  transport-only deploy key) is independently shrinking.
- **Arm (3), documentation alone** — insufficient on its own: the vector is producer-influenceable
  across rounds, which warrants observability, not prose alone.

---

## Origin: "Fix-loop `fixing` lane state" — why a new lane state instead of `needs-human`

The current page states what `fixing` is and cites its enforcement/tests as a mechanism table. The
argument for why review findings route to a worker-owned lane state rather than straight to human
escalation, verbatim:

---

Routing review findings (`HANDLE_THREADS`) straight to `needs-human` (`merge-driver.ts`'s
`deriveGate`) would ask a human to *resolve* a review, inverting the autonomy principle
(humans adjudicate reviews, they never resolve them). Instead, the producing worker gets its own
lane state to address findings itself, *before* human escalation, without ever handing it a new
dispatch or forge credentials.

---
