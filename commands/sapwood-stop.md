---
description: Trip (or lift) the sapwood kill switch, or pause/resume dispatch gently — freezes/gates new work
argument-hint: "[--lift | --pause | --resume]"
allowed-tools: Bash(mkdir:*), Bash(touch:*), Bash(rm:*), Bash(echo:*)
---

sapwood has two tiers of human control, both plain file sentinels next to the engine's
state DB (`engine/src/state/state.ts`) — no config edit needed for either:

- **kill switch** (`data/KILL_SWITCH`, `killSwitchPath`) — the strict tier. Freezes ALL new
  dispatch and merges; running workers are asked to hand off gracefully within
  `cfg.cost.drainWindowSec`, then the conductor escalates to a hard kill. Use this to stop
  the engine.
- **pause** (`data/PAUSE`, `pausePath`, #75) — the gentle tier. Freezes new lane dispatch
  ONLY: no new work is claimed or launched. Everything already in flight keeps going exactly
  as normal — running workers finish their work, and PRs already open keep moving through the
  review/merge gate. No drain, no freeze, nothing killed. Use this to stop taking on new
  issues while letting the current round finish cleanly (e.g. before a maintenance window, or
  to hold the queue while triaging).

If both sentinels are present, the kill switch wins — pause adds no further restriction
beyond what the kill switch already does.

Note for `sapwood run --until-idle`: a paused engine dispatches nothing, so once its
in-flight lanes finish it counts as idle and the run EXITS ("finish the round, then
stop"). Removing `data/PAUSE` afterwards resumes nothing by itself — start a new
`sapwood run`. Under `forever` mode the engine keeps ticking and `--resume` takes
effect on the next tick as described below.

If the argument is `--lift`, resume the engine from the kill switch by removing that
sentinel:

```bash
rm -f data/KILL_SWITCH && echo "kill switch lifted (data/KILL_SWITCH removed) — dispatch and merges can resume next tick."
```

If the argument is `--pause`, pause new dispatch by creating the PAUSE sentinel:

```bash
mkdir -p data && touch data/PAUSE && echo "paused (data/PAUSE) — no new lane dispatch; in-flight workers and PR review/merge proceed normally. Run /sapwood-stop --resume to resume dispatch."
```

If the argument is `--resume`, lift the pause by removing the PAUSE sentinel:

```bash
rm -f data/PAUSE && echo "pause lifted (data/PAUSE removed) — dispatch can resume next tick."
```

Otherwise (no argument, or any other argument), trip the kill switch:

```bash
mkdir -p data && touch data/KILL_SWITCH && echo "kill switch SET (data/KILL_SWITCH) — new dispatch/merges frozen; running workers drain within cfg.cost.drainWindowSec, then a hard stop. Run /sapwood-stop --lift to resume."
```

Report the resulting message back to the user verbatim.
