---
description: Emergency-stop, trip/lift the kill switch, or pause/resume dispatch — three human-control tiers
argument-hint: "[--emergency | --clear-emergency | --lift | --pause | --resume]"
allowed-tools: Bash(mkdir:*), Bash(touch:*), Bash(rm:*), Bash(echo:*)
---

sapwood has three tiers of human control, all plain file sentinels next to the engine's
state DB (`engine/src/state/state.ts`) — no config edit needed for any of them:

- **emergency stop** (`data/EMERGENCY_STOP`, `estopPath`) — the strictest tier. It is checked
  before the kill switch every tick and wins when both sentinels are present. In the normal path,
  it hard-kills every running/fixing lane's process group on that same tick: there is no drain
  window, in-flight WIP is lost, and killed lanes escalate to `needs-human` with their evidence
  preserved. The kill itself is forge-free — a synchronous durable-PID signal that runs before any
  terminal-reclaim or probe-before-reclaim forge read, so a hung or rejecting forge call can never
  delay or prevent it (#778); only the `needs-human` labels/comments that follow are forge calls,
  and they're best-effort, never gating the kill. Use it only for credential exposure, destructive
  calls, or a cost blowout faster than the drain window.
- **kill switch** (`data/KILL_SWITCH`, `killSwitchPath`) — the drain-first tier. Freezes ALL new
  dispatch and merges; running workers are asked to hand off gracefully within
  `cfg.cost.drainWindowSec`, then the conductor escalates to a hard kill. Use this to stop
  the engine unless the emergency-stop conditions above apply.
- **pause** (`data/PAUSE`, `pausePath`, #75) — the gentle tier. Freezes new lane dispatch
  ONLY: no new work is claimed or launched. Everything already in flight keeps going exactly
  as normal — running workers finish their work, and PRs already open keep moving through the
  review/merge gate. No drain, no freeze, nothing killed. Use this to stop taking on new
  issues while letting the current round finish cleanly (e.g. before a maintenance window, or
  to hold the queue while triaging).

The precedence order is emergency stop, then kill switch, then pause. If both
`data/EMERGENCY_STOP` and `data/KILL_SWITCH` are present, emergency stop wins; either strict tier
already subsumes pause's dispatch restriction.

Note for `sapwood run --until-idle`: a paused engine dispatches nothing, so once its
in-flight lanes finish it counts as idle and the run EXITS ("finish the round, then
stop"). Removing `data/PAUSE` afterwards resumes nothing by itself — start a new
`sapwood run`. Under `forever` mode the engine keeps ticking and `--resume` takes
effect on the next tick as described below.

If the argument is `--emergency`, set the emergency-stop sentinel:

```bash
mkdir -p data && touch data/EMERGENCY_STOP && echo "EMERGENCY STOP SET (data/EMERGENCY_STOP) — in the normal path, running/fixing lane process groups hard-kill this tick via a forge-free synchronous durable-PID signal; no drain window and in-flight WIP is lost. Clear with /sapwood-stop --clear-emergency only after human review."
```

If the argument is `--clear-emergency`, clear the emergency-stop sentinel:

```bash
rm -f data/EMERGENCY_STOP && echo "emergency stop cleared (data/EMERGENCY_STOP removed) — the kill switch or pause, if still present, continues to apply."
```

If the argument is `--lift`, clear the kill-switch sentinel:

```bash
rm -f data/KILL_SWITCH && echo "kill switch lifted (data/KILL_SWITCH removed) — EMERGENCY_STOP or PAUSE, if still present, continues to apply."
```

If the argument is `--pause`, pause new dispatch by creating the PAUSE sentinel:

```bash
mkdir -p data && touch data/PAUSE && echo "paused (data/PAUSE) — no new lane dispatch; in-flight workers and PR review/merge proceed normally. Run /sapwood-stop --resume to remove PAUSE; dispatch can resume only if no EMERGENCY_STOP or KILL_SWITCH remains."
```

If the argument is `--resume`, lift the pause by removing the PAUSE sentinel:

```bash
rm -f data/PAUSE && echo "pause lifted (data/PAUSE removed) — EMERGENCY_STOP or KILL_SWITCH, if still present, continues to apply."
```

Otherwise (no argument, or any other argument), set the drain-first kill switch:

```bash
mkdir -p data && touch data/KILL_SWITCH && echo "kill switch SET (data/KILL_SWITCH) — new dispatch/merges frozen; running workers drain within cfg.cost.drainWindowSec, then a hard stop. Run /sapwood-stop --lift to remove it; EMERGENCY_STOP or PAUSE, if present, still applies."
```

Report the resulting message back to the user verbatim.
