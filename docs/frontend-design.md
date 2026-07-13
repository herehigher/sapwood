# sapwood dashboard — frontend design (v0.2)

Design specification for the v0.2 dashboard (issue #17). This document owns the
*frontend* decisions: product scope, information architecture, visual identity,
motion, copy, and the data contract the UI consumes. [`PLAN.md`](PLAN.md)'s v0.2
chapter owns the *why* and the dogfood/recording plan; it references this file
and duplicates nothing from it.

Status: **design locked for v0.2 implementation issues; pixels may evolve, scope
decisions and the data contract only change by amending this doc.**

Amended 2026-07-13 (post-M5 wave 2): the rounds ledger + round artifacts
landed (#123), standby (#125), gated re-entry (#147), and live in-flight cost
estimates (#33) are engine reality on `main` — sections below updated to
match; the stacked budget-bar rule (§3 E) was decided on issue #17.

---

## 1. Goals & audiences

The dashboard has one job: **make the invisible loop visible** — show at a
glance that autonomous agents are producing real, reviewed work *and* that the
governance gates are holding. Everything on screen serves one of two readers:

- **The operator** (owner of a repo running sapwood): "is it alive, what is each
  lane doing, what has it cost me today, does anything need me?"
- **The evaluator** (developer deciding whether to adopt sapwood): the dashboard
  *is* the pitch. The recorded dogfood run — sapwood building this very
  dashboard — replays inside it as the launch demo.

Design consequence: the default view must read correctly in a 10-second glance
(operator) and reward a 2-minute watch (evaluator). No view exists for a third
audience.

## 2. Scope decisions (issue #17 comment → v0.2)

Every functional suggestion from the issue #17 discussion, with an explicit
in/out call:

| # | Suggestion | Decision | Rationale |
|---|---|---|---|
| 1 | Dynamic visual of the whole flow (anime.js) | **IN — the hero.** One animated Loop scene: Backlog → Lanes → Gate ① → Gate ② → Merged. | The promo centerpiece. anime.js (~10 kB) is the single animation dependency, scoped to this scene; all other motion is CSS. |
| 2 | See the agent roles interacting | **IN**: conductor, worker, reviewer, merge driver as actors in the hero scene and lane cards; the round-orchestrator roles (PO/architect/plan review/harvest/retro) as a phase strip lit from live data. | The `rounds` table carries the live phase cursor and `round_artifacts` the per-round history (#123, [round-artifact.md](round-artifact.md)) — the phase strip renders real state, never fake animation. Deep round-browse views stay deferred (§10). |
| 3 | Per-node status, output summary, cost | **IN**: lane board from `workers` (+ per-lane cost from `spend_ledger`); header status strip with daily-spend meter. | Settled (real) cost comes from `spend_ledger` at lane end; **in-flight cost is the engine's #33 estimate** (the pricing.yaml table that already drives the soft worker budget), shown marked `est` and settling to real when the lane ends. |
| 4 | Browse past loop rounds | **IN via replay, not metrics.** The `events` table is a complete append-only history → a replay player (play/pause/scrub) re-drives the whole UI from any point. | History-*aggregation* metrics (cycle time, merge/rework rate) stay **OUT** — PLAN.md defers them to a later phase gated on GitHub-history work. |
| 5 | Config panel | **IN as read-only.** Grouped, plain-language view of the resolved config. **Editing is OUT.** | A write path would break the dashboard's read-only security posture, and security-relevant config is human-merge-only territory. Edit via the YAML file, where review applies. |
| 6 | Avoid jargon | **IN as a copy layer**: one map from the 19 event kinds to plain sentences (§7). UI language is English (repo/launch artifact); the map is a single module, trivially localizable later — no i18n framework. | |
| 7 | Spec-first, consistent styling | **IN — this document.** Design tokens (§5) are defined before any component; one CSS file of custom properties is the only styling mechanism. | |

**Weight budget** (a plugin-local tool must stay light — this table is the
acceptance bar, checked at review):

| Budget item | Limit |
|---|---|
| Runtime dependencies | ≤ 5: `react`, `react-dom`, `@tanstack/react-query`, `animejs` |
| Chart library | none — cost bars/sparklines are hand-rolled SVG |
| CSS framework / CSS-in-JS | none — one `tokens.css` + one `app.css` |
| Server | `node:http` + `node:sqlite` (read-only), 127.0.0.1-bound; no Express |
| Transport | HTTP polling (3 s via TanStack Query); no WebSocket |
| Fonts | one bundled display face (subset woff2); system stacks for body & data |

## 3. Information architecture

Single page, no routing. Five modules, one screen:

```
┌──────────────────────────────────────────────────────────────┐
│ ◉ sapwood    ● running     spend ▓▓▓░░ $12 / $100    [Replay]│  A header
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Backlog ─▶ ┃lane┃lane┃lane┃ ─▶ ① checks ─▶ ② review ─▶ ◎   │  B hero
│   (issues)    workers write      CI green    independent  rings│
├───────────────────────────────────┬──────────────────────────┤
│ C lanes                           │ D activity               │
│ ┌────────┐ ┌────────┐ ┌────────┐  │  Merged PR #94           │
│ │ #86 ●  │ │ #88 ◐  │ │ (idle) │  │  Lane 2 handed off       │
│ │ $1.20  │ │ PR #97 │ │        │  │  Started issue #90       │
│ └────────┘ └────────┘ └────────┘  │  …                       │
├───────────────────────────────────┴──────────────────────────┤
│ E cost strip — today by lane / by model (SVG bars)  [Config ▸]│
└──────────────────────────────────────────────────────────────┘
```

- **A — Header.** Wordmark; engine state as one word + dot (`running` /
  `standby` / `stalled` / `paused` / `winding down` / `stopping` / `stopped` —
  derived from sentinels, ceiling breach, standby events, and `lastTickAt`
  age, §8; `standby` renders calm, never as an error); daily-spend meter
  (today vs `cost.dailyBudgetUsd`); the Live ↔ Replay toggle.
- **B — Hero: the Loop.** The whole pipeline as one horizontal scene (§6).
  Fixed stage; real events move tokens through it. Ends in the **trunk
  cross-section**: every merged PR accretes one growth ring (§5, signature).
- **C — Lane board.** One card per lane up to `lanes.max`; empty lanes render
  as quiet outlines ("an empty lane is capacity, not absence"). Card: issue
  number (linking to GitHub — title enrichment is deferred, §10), state word,
  PR link when driving, elapsed time, and cost — the engine's in-flight
  **estimate** (marked `est`, #33) while running, settling to the
  `spend_ledger` real sum when the lane ends.
- **D — Activity feed.** The `events` stream through the copy map (§7),
  newest first, relative timestamps; kind-colored dot per entry. Payload
  details (worker, head, mode) collapse behind each entry — never in the
  sentence.
- **E — Cost strip + Config drawer.** Two small SVG bar groups: today's spend
  by lane, and by model (token split available on hover). `Config ▸` opens a
  read-only drawer: an **allowlisted subset** of the resolved config (the
  server serves named keys, never the whole object — the no-secrets guarantee
  stays structural even if future config grows sensitive keys), grouped as
  **Board · Lanes · Worker · Safety · Review & merge · Labels**, each key with
  its plain-language caption
  (e.g. `worker.budgetUsdSoft` → "Budget per worker — reaching it asks the
  worker to wrap up and hand off, never kills it mid-work").

  **Budget bars — one grammar at every tier** (decided on #17): settled real
  cost draws solid; the in-flight estimate stacks after it in the same hue at
  ~40 % alpha (or hatched) — translucency reads as "not final", which a
  lighter shade alone doesn't. Ceiling tick marks apply to the **settled
  segment only**: the hard tiers settle on real cost, so the est segment may
  legitimately cross the tick without a freeze (tooltip: "ceiling fires on
  settled cost only"). Worker-card bars are all-estimate — no split; the
  header daily meter (and a round meter, if shown) use the split. When a lane
  settles, one feed line calibrates the estimate ("est $1.10 → real $0.97").

Empty/error states are directions, not moods: fresh DB → hero idles with
"Waiting for the first dispatch — point sapwood at a Ready issue"; API
unreachable → header flips to `disconnected` with the command to restart;
config unreadable (`lanes.max` null) → hero draws a single placeholder channel
captioned "lane count unknown — config unreadable"; `needs-human` events pin
to the top of the feed until newer than any escalation.

## 4. Visual identity — growth rings

Sapwood is the living outer layer of a trunk: the part that moves sap while
the heartwood holds the record. The dashboard takes its identity from exactly
that: **activity is sap; finished work is wood.** Each merged PR draws one
ring on the trunk cross-section at the end of the hero pipeline — the product
metaphor (issues in → reviewed PRs out) becomes the visual signature: *work
becomes wood, and the rings are the record.*

The signature is spent in that one place. Around it the interface stays quiet:
calm panels, hairline rules, data set in mono. Deliberately **not** another
near-black dev dashboard with an acid accent, and not a generic cream+serif
landing page — the palette is drawn from the material itself.

## 5. Design tokens

One `tokens.css`; both themes derive from the same names. Dark ("heartwood")
is the default — it is a monitoring surface — with a light ("sapwood") theme
via `prefers-color-scheme` and a manual override.

**Color** (dark theme values; light theme swaps grounds and darkens accents
one step for contrast):

| Token | Hex | Role |
|---|---|---|
| `--heartwood` | `#251B10` | Background — warm dark brown, not near-black |
| `--panel` | `#2E2317` | Cards, drawer |
| `--sapwood` | `#F1E7D2` | Primary text (dark theme) / background (light theme) |
| `--bark` | `#8A7A64` | Borders and hairlines **only** (≈3.9:1 on `--heartwood` — below AA for text) |
| `--bark-text` | `#A6957C` | Muted text (AA-passing on both grounds) |
| `--sap` | `#E8A33D` | Amber — the *activity* color: flowing tokens, running lanes, spend meter |
| `--moss` | `#8FA36B` | Success: merged, CI green, healthy engine dot |
| `--rust` | `#C05A2E` | Failure/escalation: failed lanes, `needs-human`, ceiling breach |

Rules: `--sap` means "in motion", `--moss` means "done well", `--rust` means
"a person should look" — never decorative use of any of the three. Rings are
stroked in `--bark` at 40% alpha; the growing (current) ring in `--sap`.

**Type** — three roles, one bundled file:

| Role | Face | Use |
|---|---|---|
| Display | **Fraunces** (subset woff2, bundled — offline-safe) | Wordmark, section labels, the big ring count. Used sparingly; its warmth carries the organic identity. |
| Body | `system-ui` stack | All UI prose. Native feel, zero bytes — the honest choice for a local tool. |
| Data | `ui-monospace` stack | Issue/PR numbers, costs, timestamps, config keys. A tool dashboard is mostly data; the mono face does the daily work. |

Scale: 13 px base (data-dense surface), 1.25 ratio up to the 33 px display
size; line-height 1.5 body, 1.2 display. Weights: 400/600 only.

**Space & shape:** 4 px grid; radii 6 px (cards) / 999 px (dots, pills);
borders are 1 px `--bark` at 25% alpha — no shadows (wood has grain, not
elevation).

**Motion tokens:** `--beat: 240ms` (state flips), `--travel: 900ms` (token
movement in the hero), easing `cubic-bezier(.3,.7,.3,1)`; ambient pulses ≥ 3 s.

**Quality floor** (not negotiable, not announced): responsive to 720 px wide
(modules stack A→B→C→D→E), visible keyboard focus (`--sap` outline), WCAG AA
contrast in both themes — **every text-on-ground token pair is checked with a
contrast tool at implementation, per theme**, `prefers-reduced-motion` honored
(§6). Color is never the sole carrier: gate resolutions get a ✓/✕ glyph,
failed lanes a static ✕ (moss/rust is deuteranopia-ambiguous), and the
activity feed is the hero's accessible text channel (`aria-live="polite"` on
new entries). The est/settled budget-bar split (§3 E) also never relies on
color alone — the est segment carries a texture (hatch) or the `est` label.

## 6. Motion spec — the hero Loop

The hero is a fixed stage (SVG): backlog stack → lane channels (`lanes.max`
of them) → gate ① (checks) → gate ② (review) → trunk cross-section. Roles are
labeled *on the stage itself* in plain words: the conductor is the stage (it
schedules everything); workers are the lane channels; the reviewer sits at
gate ②; the merge driver is the arm between gate ② and the trunk. A slot row above
the stage names the round phases (PO · goal alignment → architect → gate⓪
plan review → harvest → retro); the slot matching the open round's
`rounds.phase` is lit, the rest stay dimmed. Illumination only — phase slots
never animate droplets (peripheral work externalizes as issues and comments,
not lanes).

An issue is a **sap droplet** (amber dot with the issue number). Real events
drive it, via one anime.js timeline per transition:

| Event(s) | Animation |
|---|---|
| `dispatched` | Droplet detaches from the backlog stack, travels into a lane channel (`--travel`); the lane card (§3 C) lights `--sap` in the same beat. |
| lane `running → driving` (from `/state` polling) | Droplet emerges from the lane carrying a PR tag and parks **in the gate section** (drawn as the two gates ①②, labeled "checks" and "review"), which breathes softly while the PR waits. The engine computes gate progress live against GitHub and persists no substate, so v0.2 renders the review passage as one *waiting* state — the gates never fake per-gate progress. (A persisted `gate-advanced` event unlocking the two-step animation is deferred, §10.) |
| `merged` | Both gates flash `--moss` with a ✓, the droplet crosses the merge arm into the trunk and **becomes a ring**: a new circle strokes in over 1.2 s, ring counter increments in Fraunces. The one celebratory moment. |
| `handoff` | Droplet folds back into the backlog with a small progress badge ("saved for a successor"). |
| `reclaim-failed`, `reclaim-dead`, `drive-needs-human`, `rollback-escalated` | Droplet stops, flips `--rust` with a static ✕, and pins a marker above its position; no shaking, no bouncing — failures are still, not loud. |
| `ceiling-escalated` / PAUSE / kill switch | Stage dims; ambient sap flow stops; header state word explains. |

Ambient (CSS only): a faint sap shimmer along active lane channels (≥ 3 s
cycle); the current outermost ring breathes at low amplitude while any lane
is running.

**Coalescing policy** (bursts must not queue): animated transitions are
budgeted, not unbounded. If more than 2 transitions are pending (poll catch-up
after a gap, multi-merge ticks) — or replay speed is ≥ ×4 — pending
transitions collapse to instant state swaps and only the newest ring stroke
animates. The hero must never lag behind the state it claims to show.

`prefers-reduced-motion`: all travel becomes instant position/color swaps;
rings appear without stroke animation; ambient shimmer off. The scene remains
fully legible — motion is commentary, never the only carrier of state.

**Replay mode** drives the identical scene from historical events: a transport
(play/pause, speed ×1/×4/×16, scrub bar spanning the event log — with chapter
marks, one per closed round from `round_artifacts`) replaces the polling
source. Scrubbing rebuilds state by folding events up to the cursor —
same reducer as live mode, one code path; the fold keeps periodic checkpoints
(every ~500 events) so scrubbing stays O(distance), not O(log-length).
**Replay covers event-backed panels only** — hero, lane narrative, feed, ring
count. Snapshot-backed panels (spend meter, cost strip, config drawer) have no
historical source (event payloads carry no cost; spend lives in
`spend_ledger`) and grey out in replay with the caption "live only".

**Launch artifact** — two forms, both from the recorded dogfood run:
(a) a screen capture of the replay for README/launch page, and (b) a **demo
fixture mode**: the run's event log ships as a bundled JSON fixture, and
`?demo` feeds it to the same replay player — an interactive demo that runs
with no engine, no DB, on a static host. No new dependency; the replay reducer
is the mechanism either way.

## 7. Copy — the plain-language layer

All user-visible sentences live in one module (`copy.ts`), keyed by event
kind. Voice: active, specific, no system internals (say "lane", "checks",
"review", never "reclaim", "tick", "worktree"). The 31 kinds (12 added
post-lock by #110/#123/#125/#147 — **every engine PR that adds an event kind
must extend this map; make it a gate② checklist item**):

| Event kind | Feed sentence |
|---|---|
| `dispatched` | Started work on issue #{issue} |
| `dispatch-failed` | Couldn't start issue #{issue} — it's back in the backlog |
| `reclaim-done` | Branches on `payload.next`: PR produced → "Lane {worker} opened a PR — now in review"; ended without a PR → "Lane {worker} ended without a PR — flagged for a human" |
| `reclaim-failed` | Lane {worker} hit a problem and stopped |
| `reclaim-dead` | Lane {worker} went silent — cleaned up; its issue goes back to the backlog |
| `handoff` | Lane {worker} reached its budget and saved its progress for a successor |
| `merged` | Merged PR #{pr} — checks green and review approved |
| `drive-needs-human` | PR #{pr} needs a human decision |
| `drive-no-pr` | Lane {worker} ended without opening a PR |
| `drive-queued` | PR #{pr} is ready — waiting its turn to merge |
| `drive-stopped` | PR #{pr} is open and left for you — auto-merge is off |
| `ceiling-escalated` | Safety ceiling reached — winding down all work |
| `rollback-recovered` | Returned issue #{issue} to the backlog safely |
| `rollback-retry-failed` | Still trying to return issue #{issue} to the backlog |
| `rollback-escalated` | Couldn't return issue #{issue} automatically — flagged for a human |
| `reviewer-fallback-switch` | The usual reviewer isn't answering — switched to the backup |
| `reviewer-fallback-revert` | The usual reviewer is back — switched back |
| `worktree-retained` | Kept lane {worker}'s working folder for inspection |
| `tick-error` | The engine hit an error this cycle — it will retry |
| `standby-wait` | Nothing to work on — checking again in {waitSec} s |
| `standby-exit` | Work appeared — resuming after {attempts} quiet check(s) |
| `round-stop` | This round reached its limit ({detail}) — no new work this round |
| `align-summary` | Planning pass: {n} issue(s) created, {m} plan(s) drafted |
| `triage-degraded` | A planning session had trouble — some issues keep their old plans |
| `no-plan-after-draft` | Issue #{issue} still has no usable plan after a drafting attempt |
| `plan-review-escalated` | Issue #{issue}'s plan needs a human — automated review couldn't approve it |
| `gated-reentry` | Issue #{issue}'s PR was unblocked by a human — back through review |
| `gated-reentry-capped` | Issue #{issue} was unblocked too many times without landing — flagged for a human |
| `gated-reentry-capped-label-failed` | Couldn't re-flag issue #{issue} — please check it manually |
| `retro-pr-opened` | The loop proposed an improvement to itself — PR #{pr} awaits review |
| `retro-pr-degraded` | A self-improvement proposal didn't come together this round |

The same module captions lane states (`running` → "writing", `driving` → "PR
under review", `handoff` → "handed off") and config keys (§3 E). Adding an
event kind without a copy entry is a type error.

## 8. Data contract

Three read-only endpoints, served from the existing SQLite tables
(schema v11, `engine/src/state.ts` — including `rounds` and
`round_artifacts`); no dashboard-specific engine tables. Response shapes
mirror what `StatusSnapshot` (`engine/src/cli.ts`) already computes for
`sapwood status`.

**`GET /api/loop/state`** — everything current, one poll:

```jsonc
{
  "engine": {
    "state": "running",            // running | standby | stalled | paused | winding-down | stopping | stopped
                                    // derived: KILL_SWITCH + active lanes → stopping (drain in
                                    // progress); KILL_SWITCH + none → stopped; ceiling_breach →
                                    // winding-down; PAUSE → paused; lastTickAt older than the
                                    // engine's stale-gap threshold → stalled (dead engine must
                                    // not read as a green "running"); no open round + newest
                                    // standby-wait newer than any standby-exit → standby
                                    // (parked, healthy — #125); else running.
                                    // Precedence: sentinel files > newest event > staleness
                                    // overrides everything (docs/loop-walkthrough-v0.2.md §6)
    "reasons": [],                  // ceiling_breach.reasons when winding-down
    "lastTickAt": "2026-07-09T08:12:00Z"   // engine_session.last_tick_at
  },
  "lanes": {
    "max": 3,                       // config lanes.max (null if config unreadable)
    "items": [{                     // workers rows, running + driving
      "lane": "w1", "issue": 86,    // numbers link out to GitHub; no title (deferred, §10)
      "state": "driving", "pr": 97,
      "startedAt": "…", "endedAt": null,
      "costUsd": null,              // SUM(spend_ledger) per worker — real cost, written at
                                    // reclaim; null while in flight
      "estCostUsd": 0.73,           // priced-cost snapshot (#33 pricing pipeline, pricing.yaml) —
                                    // the same signal driving the soft worker budget. Persisted
                                    // per probe while the lane runs (#155, workers.est_cost_usd);
                                    // settles into costUsd (the real bill) at reclaim, and this
                                    // column is cleared back to null the instant the lane leaves
                                    // `running` — the UI shows the settled costUsd only from then on
      "contextTokens": 41000,       // newest assistant message's input + cache_read (+
                                    // cache_creation) tokens — what the model saw last turn.
                                    // Deliberately NON-monotonic (a drop marks an auto-compact,
                                    // itself display-worthy). Denominator for a % gauge is
                                    // pricing.yaml's per-model contextWindow (#155). null while
                                    // not running
      "tokenComposition": {         // cumulative 4-class split for the running lane (#155) — raw
        "inputTokens": 12000, "outputTokens": 3000,
        "cacheReadTokens": 90000, "cacheCreationTokens": 4000
      }                            // totals mislead (cache reads are huge and cheap); null
                                    // while not running
    }]
  },
  "round": { "id": 12, "phase": "executing" },  // live phase cursor (rounds table);
                                                 // null when no round is open (standby)
  "spend": {
    "todayUsd": 12.4,               // dailySpendUsd()
    "dailyBudgetUsd": 100,          // config (null if unreadable)
    "byModel": [{ "model": "opus", "usd": 10.1,
                  "inputTokens": 0, "outputTokens": 0 }]
  },
  "rings": 27,                      // COUNT(events WHERE kind='merged') — the ring count
  "config": { /* ALLOWLISTED subset of resolved config (§3 E) — the server names the
                 keys it serves; never the whole object */ }
}
```

**`GET /api/events?after=<id>&limit=<n>`** — the append-only feed, ascending
by `id`; live mode polls with the last seen id, replay mode pages from
`after=0`:

```jsonc
{ "events": [{ "id": 512, "ts": "…", "kind": "merged",
               "payload": { /* stored JSON, verbatim */ } }],
  "lastId": 512 }
```

**`GET /api/rounds`** — replay chapter marks and (deferred) round browsing;
one row per closed round from `round_artifacts`, ascending:

```jsonc
{ "rounds": [{ "roundId": 12, "schemaVersion": 1,
               "artifact": { /* the validated JSON, verbatim —
                                docs/round-artifact.md is the contract; the UI
                                checks schemaVersion and says "newer schema —
                                update the dashboard" rather than mis-render */ } }] }
```

Server: `node:http` on `127.0.0.1` (port configurable, default 4517), SQLite
opened read-only, serves `dashboard/dist` statics plus these two routes. No
POST/PUT/DELETE routes exist — the read-only posture is structural, not
policy.

## 9. Tech architecture

```
dashboard/            # new npm workspace — implementer MUST add "dashboard" to root
                      # package.json "workspaces" (currently ["engine"] only), or root
                      # -ws build/test/typecheck silently skip the package and CI lies
  server.ts           # node:http + node:sqlite, ~150 LOC, no deps
  src/
    api/              # fetch + TanStack Query hooks (poll 3 s)  ── the data layer
    replay/           # event-folding reducer + player hook      ── shared with live
    hero/             # SVG stage + anime.js timelines
    components/       # Header, LaneBoard, Feed, CostStrip, ConfigDrawer
    copy.ts           # §7 — the single copy map
    tokens.css  app.css
```

- **Build:** Vite + React + TypeScript; `vite build` output embedded in the
  plugin package. Dev: `vite` proxying `/api` to the local server.
- **One state reducer** folds events into UI state; live mode feeds it the
  polling tail, replay (and the `?demo` fixture) feeds it history. The hero,
  lane narrative, feed, and ring count render from the reducer output, so
  those panels replay for free. Snapshot-backed panels (spend, config) render
  from `/api/loop/state` only and grey out in replay (§6).
- Launched via a `sapwood dashboard` CLI/slash command that starts the server
  and opens the browser. Read-only DB handle; safe to run beside a live engine
  (WAL mode).

## 10. Deferred (v0.3+)

- **Config editing** — needs a write path + auth story; contradicts v0.2's
  read-only posture.
- **Deep round-browse views** (per-round drill-down pages beyond the lit
  phase strip and replay chapters, which are IN for v0.2) — the
  `round_artifacts` data exists; the additional UI surface is not v0.2 scope.
- **History-aggregation metrics** (cycle time, merge/rework rate) — deferred
  by PLAN.md, gated on GitHub-history work.
- **WebSocket push** — polling at 3 s is indistinguishable for a local
  single-viewer tool; revisit only if a hosted multi-viewer mode ever exists.
- **Issue-title enrichment** in lane cards (needs a GitHub read from the
  dashboard server; v0.2 links out instead).
- **Per-gate progress in the hero** — needs the engine to persist gate
  substate (a `gate-advanced` event); v0.2 renders the review passage as one
  waiting state (§6).
- **Replayable cost panels** — needs cost folded into `merged`/reclaim event
  payloads; v0.2 greys spend panels in replay.
- **Localization** — the copy map is the seam; add locales when someone asks.
