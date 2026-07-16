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

Amended 2026-07-16 (replay/live boundary review): replay ↔ live boundary,
round identity, and replay cost semantics decided — see §11. Spend panels now
**replay** from `spend_ledger` (supersedes the earlier §6/§10 grey-out rule
for spend); the header meter's tier rule changed from daily to run (§3 A);
two additive engine events are required (`round-phase`, `run-started` — §11).

Amended 2026-07-16 (design-director review, second amendment): the hero is now
a **closed loop**, not a horizontal stage (§6); the light theme shifts from
cream to pale sapwood green (§5); the cost strip re-buckets to **phase +
model** (§3 E); issue/PR numbers gain title tooltips and type glyphs, and
stages/lanes gain model·effort captions (§3, §5); clicking a stage node opens
a read-only **phase inspector** drawer (§6); stage labels lead with plain
language, backed by hover explainers and a legend (§7). One additional engine
follow-up: issue/PR titles persisted in event payloads (§11).

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
│      ╭─▶ PO ─▶ Architect ─▶ ⓪ plan review ─╮                 │
│      ┆                                     ▼                 │  B hero
│  Backlog ─▶ ┃lane┃lane┃lane┃ ─▶ ①checks ─▶ ②review ─▶ ◎rings│  (closed
│      ┆                                     │                 │   loop)
│      ╰╌╌ Retro ◀─ Harvest ◀────────────────╯                 │
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
  age, §8; `standby` renders calm, never as an error); the spend meter —
  **run-cumulative vs the per-run stop budget** (`stop.afterSpendUsd`, the
  #154 run-scoped ledger sum): numerator and denominator must always come
  from the **same budget tier** (§11); with no run budget configured the
  meter falls back whole to the daily tier (today vs `cost.dailyBudgetUsd`),
  never a mixed-tier fraction. The daily hard ceiling stays visible as a
  small secondary readout — it is the line that actually stops the engine.
  Then the Live ↔ Replay toggle.
- **B — Hero: the Loop.** The whole pipeline as one **closed loop** (§6):
  round phases arc across the top, the worker pipeline runs through the
  middle, harvest/retro return along the bottom back to PO. Fixed stage;
  real events move tokens through it. The worker pipeline ends in the
  **trunk cross-section**: every merged PR accretes one growth ring (§5,
  signature). Stage nodes are clickable — the phase inspector (§6).
- **C — Lane board.** One card per lane up to `lanes.max`; empty lanes render
  as quiet outlines ("an empty lane is capacity, not absence"). Card: issue
  number (linking to GitHub), state word, PR link when driving, elapsed time,
  the lane's model·effort caption (mono, e.g. `opus · high`, from the config
  allowlist — flips with `reviewer-fallback-*` / fallbackModel events where
  applicable), and cost — the engine's in-flight **estimate** (marked `est`,
  #33) while running, settling to the `spend_ledger` real sum when the lane
  ends.

  **Issue/PR numbers — everywhere they appear** (lane cards, feed, hero
  droplets, ring tags): (a) a **type glyph** distinguishes them at a glance —
  issue = circle-dot ⊙, PR = merge-arrow, inline SVG, never color as the
  sole carrier (§5); (b) **hover shows the title** in a tooltip. Titles come
  from event payloads persisted by the engine at dispatch/PR-open/merge
  (§11 follow-up #3) — the dashboard never queries GitHub for them, so
  tooltips work offline and in replay. Events predating the payload field
  simply show no tooltip.
- **D — Activity feed.** The `events` stream through the copy map (§7),
  newest first, relative timestamps; kind-colored dot per entry. Payload
  details (worker, head, mode) collapse behind each entry — never in the
  sentence.
- **E — Cost strip + Config drawer.** Two small SVG bar groups: today's spend
  **by phase** (align / architect / gate⓪ / workers / harvest / retro) and
  **by model** (token split available on hover). Phase, not lane: lanes are
  short-lived reused slots (w1/w2/w3), so a by-lane day aggregate carries
  little meaning — per-lane cost already lives on the lane cards (§3 C), and
  the phase bucketing matches the replay round tier (§11). `Config ▸` opens a
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
one step for contrast). The light theme's grounds are **pale sapwood green**,
not cream: background a milky warm pale green, panels one step greener — the
literal color of a trunk's living sapwood layer, which carries the identity
better than a generic cream landing page. Consequence: `--moss` (success)
loses signal against a greenish ground, so the light theme's success color
shifts to a deeper teal-green, and **every text-on-ground pair is re-checked
for WCAG AA per theme** (the §5 quality floor already requires this; the
palette shift makes it load-bearing, not pro-forma):

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
failed lanes a static ✕ (moss/rust is deuteranopia-ambiguous), issue vs PR
numbers carry their type glyphs (⊙ / merge-arrow, §3 C), and the
activity feed is the hero's accessible text channel (`aria-live="polite"` on
new entries). The est/settled budget-bar split (§3 E) also never relies on
color alone — the est segment carries a texture (hatch) or the `est` label.

## 6. Motion spec — the hero Loop

The hero is a fixed stage (SVG) drawn as a **closed loop** — the round's
circular nature is the geometry itself, not a caption. Three tiers, one
circuit (§3's sketch): the round-phase arc across the top (PO → architect →
gate⓪ plan review), feeding down into the worker pipeline through the middle
(backlog stack → lane channels, `lanes.max` of them → gate ① checks →
gate ② review → trunk cross-section), whose rings arc closes along the bottom
(harvest ← retro) with a dashed return path back to PO. Roles are labeled
*on the stage itself* in plain words (§7's stage-label rule): the conductor
is the stage (it schedules everything); workers are the lane channels; the
reviewer sits at gate ②; the merge driver is the arm between gate ② and the
trunk. Each stage node carries its model·effort caption (§3 C).

**Two kinds of motion, one honesty rule.** A **droplet** is a real entity —
an issue or a PR — and only real events move it (table below). The **pipes
themselves carry sap flow**: the segment belonging to the open round's
`rounds.phase` renders a slow liquid-flow ambient (CSS, ≥ 3 s cycle) while
that phase is active, and stills when it isn't. Phase nodes light with their
segment but never emit droplets — peripheral work externalizes as issues and
comments, not lanes; the flow says "this part of the organism is working",
the droplets say "this artifact moved". Nothing animates that isn't backed
by live state.

**Phase inspector** (new, this amendment): clicking any stage node opens a
read-only side drawer for that phase — the stage's inputs/outputs and its
paper trail, not just its light. Contents, by data source: the phase's slice
of the **latest round's data** — for the open round, folded from its events
so far (e.g. `align-summary` → created/triaged list); for a phase the open
round hasn't reached, the most recent **closed** round's `round_artifacts`
slice (labeled with its round id — never presented as current); plus the
node's model·effort (config allowlist), links out to the GitHub artifacts
the phase produced (issues, plan comments, PRs), and a "view log" pointer to
the run-scoped engine log (#193). Cross-round *browsing* stays deferred
(§10) — the inspector is one drawer about the latest state of one phase,
not a history UI.

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

**Replay mode** drives the identical scene from history: a transport
(play/pause, speed ×1/×4/×16, scrub bar) replaces the polling source. The
**unit of replay is the round** (§11): the scrubber spans one round's event
window ("event 12 / 33"), with chapter navigation across rounds — a full-run
replay is simply the ordered chapter list, and inter-round events attach to
the start of the following chapter. Scrubbing rebuilds state by folding
events up to the cursor — same reducer as live mode, one code path; the fold
keeps periodic checkpoints (every ~500 events) so scrubbing stays
O(distance), not O(log-length).

What replays and what doesn't follows one rule — **append-only sources
replay; mutable or external state is live-only** (§11). Hero, lane
narrative, feed, and ring count (from `events`) *and* the spend meter + cost
strip (from `spend_ledger`, equally append-only) all replay; est overlays,
the config drawer, and backlog/board counts are live-only and dim with an
on-panel "live only" badge — never merely a footnote.

**Launch artifact** — two forms, both from the recorded dogfood run:
(a) a screen capture of the replay for README/launch page, and (b) a **demo
fixture mode**: the run's event log ships as a bundled JSON fixture, and
`?demo` feeds it to the same replay player — an interactive demo that runs
with no engine, no DB, on a static host. No new dependency; the replay reducer
is the mechanism either way.

## 7. Copy — the plain-language layer

All user-visible sentences live in one module (`copy.ts`), keyed by event
kind. Voice: active, specific, no system internals (say "lane", "checks",
"review", never "reclaim", "tick", "worktree"). The 33 kinds (12 added
post-lock by #110/#123/#125/#147, plus `run-started`/`round-phase` required
by §11 and pending their engine issue — **every engine PR that adds an event
kind must extend this map; make it a gate② checklist item**):

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
| `run-started` | Engine started a new run |
| `round-phase` | Round {round_id} moved into {phase} |

The same module captions lane states (`running` → "writing", `driving` → "PR
under review", `handoff` → "handed off") and config keys (§3 E). Adding an
event kind without a copy entry is a type error.

**Stage labels lead with plain language** (decided at the design-director
review: PO / gate⓪ / harvest / retro are jargon to anyone who hasn't read
PLAN.md, and the small-print caption "PO · goal alignment" is still jargon).
On the stage the plain word is the **primary** label and the internal term
the secondary small print — not the other way around:

| Stage (internal) | Primary label | Hover explainer (one sentence, from `copy.ts`) |
|---|---|---|
| PO / aligning | Planning | Decides what's worth doing this round and files it as issues |
| Architect | Design review | Checks the round's plans fit the architecture before work starts |
| gate⓪ plan review | Plan approval | An independent review approves each plan before any code is written |
| Lanes / workers | Writing | Autonomous workers implement approved issues, one lane each |
| gate① checks | Checks | CI must pass before a PR moves on |
| gate② review | Review | An independent reviewer approves the PR against its plan |
| Merge / rings | Merged | Approved work lands; every merged PR adds one ring |
| Harvest | Round summary | Collects what the round produced and what needs a human |
| Retro | Self-improvement | The loop proposes one improvement to itself |

These labels and explainers live in the same `copy.ts` module — one map, no
second vocabulary. A small **"?" legend toggle** in the header overlays the
three metaphor keys in one line each: droplet = an issue moving through the
loop; lane = one autonomous worker; ring = one merged PR. That is the whole
onboarding surface — no tour, no modal sequence.

## 8. Data contract

Three read-only endpoints, served from the existing SQLite tables
(schema v11, `engine/src/state/state.ts` — including `rounds` and
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
    "runUsd": 13.3,                 // #154 run-scoped ledger sum (spentUsdAfterId from the
                                    // startup anchor) — the header meter's numerator (§3 A)
    "runBudgetUsd": 100,            // stop.afterSpendUsd (null when unconfigured → the header
                                    // meter falls back whole to the daily tier, §3 A)
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

**`GET /api/spend?after=<id>&limit=<n>`** — the append-only `spend_ledger`,
same paging contract as `/api/events`; replay's cost source (§11). Rows are
served verbatim (`id, ts, worker, issue, usd, model`, token counts); the
replay cursor maps event → spend position by timestamp
(`spend_ledger.ts <= current event's ts`) — display-grade alignment, no
cross-table join.

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
  those panels replay for free. Spend panels fold `/api/spend` the same way
  (§11); only genuinely non-replayable surfaces (est overlays, config
  drawer, backlog counts) render from `/api/loop/state` alone and dim in
  replay (§6).
- Launched via a `sapwood dashboard` CLI/slash command that starts the server
  and opens the browser. Read-only DB handle; safe to run beside a live engine
  (WAL mode).

## 10. Deferred (v0.3+)

- **Config editing** — needs a write path + auth story; contradicts v0.2's
  read-only posture.
- **Deep round-browse views** (per-round drill-down pages beyond the lit
  phase strip, the replay chapters, and the single-phase inspector drawer
  (§6), which are IN for v0.2) — the `round_artifacts` data exists; the
  additional cross-round UI surface is not v0.2 scope.
- **History-aggregation metrics** (cycle time, merge/rework rate) — deferred
  by PLAN.md, gated on GitHub-history work.
- **WebSocket push** — polling at 3 s is indistinguishable for a local
  single-viewer tool; revisit only if a hosted multi-viewer mode ever exists.
- ~~Issue-title enrichment~~ — **un-deferred** by the design-director
  amendment: titles now ride event payloads written by the engine (§3 C,
  §11 follow-up #3); no GitHub read from the dashboard server was ever
  needed. Only pre-amendment events lack tooltips.
- **Per-gate progress in the hero** — needs the engine to persist gate
  substate (a `gate-advanced` event); v0.2 renders the review passage as one
  waiting state (§6).
- **Config replay** — becomes possible once `run-started` carries a
  resolved-config snapshot (§11); v0.2 keeps the config drawer live-only.
  (The earlier "replayable cost panels" deferral is superseded: `spend_ledger`
  is itself the historical source — no event-payload folding needed, §11.)

## 11. Replay ↔ Live — boundary, identity, and cost semantics

Decided 2026-07-16 (engine-behavior review against schema v11). Where this
section conflicts with older text, this section wins.

### The boundary rule

The replay/live boundary is drawn **by data shape, not by panel**: anything
reconstructible from an append-only source replays; anything that lives as a
mutable snapshot or outside the engine's own DB is live-only.

| Source | Shape | Replays? |
|---|---|---|
| `events` | append-only, id-ordered | **Yes** — the replay stream itself |
| `spend_ledger` | append-only, id-ordered | **Yes** — settled cost at any cursor is `SUM(usd)` up to it |
| `rounds.phase` | in-place UPDATE (`advanceRoundPhase` appends no event) | **Not today** — needs the `round-phase` event below |
| live telemetry (`est_cost_usd`, `contextTokens`, token split) | overwritten per probe, cleared when the lane leaves `running` (#155) | **Never** — the history never existed. Est never replays; settled only (§3 E's settled/est grammar is the same line) |
| resolved config | read at startup, unversioned | Live-only until `run-started` snapshots it |
| backlog / board | external GitHub state | Live-only |

### Round identity & the replay unit

- **`rounds.round_id` is the canonical locator** — SQLite autoincrement,
  globally monotonic, survives restarts, never reused. The UI shows it
  directly ("round 12").
- **No composite "run N, round M" identity.** Both coordinates would be
  synthetic; `round_id` alone already pinpoints a round. Run *grouping* is
  derived from `run-started` events — never inferred from the
  `engine_session` gap heuristic, which serves the wall-clock ceiling and
  deliberately resets on quiet gaps.
- **The unit of replay is the round.** Its event window is exact via the
  #123 id cursors (`start_event_id` / `start_spend_id`), immune to
  same-millisecond boundary collisions. A run replays as the ordered chapter
  list of its rounds; inter-round events attach to the following chapter.

### Cost in replay — two scales, both truncated at the cursor

- **Header meter: run tier.** Spend as of the cursor within the replayed
  run, over that run's budget — the same tier rule as live (§3 A), truncated
  at the cursor. Watching spend approach the budget while scrubbing is a
  core replay payoff.
- **Cost strip: round tier.** The replayed round's own window
  (`start_spend_id` → cursor), bucketed by phase/model. The live title
  "TODAY BY …" becomes **"THIS ROUND BY …"** in replay — "today" has no
  meaning against a historical round.
- Both numbers grow monotonically under the scrubber; **no est segments
  exist in replay** — history has only settled values.
- Cursor mapping: the scrubber cursor is an `events.id`; spend truncates by
  the current event's timestamp. Display-grade precision, no join table.

### Mode purity

- The toggle is **global**: entering Replay swaps the data source for the
  whole screen. Live values must never render beside replayed state as if
  they were one moment — the header in replay shows the *as-of-cursor*
  round/phase/spend plus a persistent REPLAY badge; whether the engine is
  currently alive shrinks to one small live indicator.
- Panels that cannot replay dim with an **on-panel** "live only" badge. A
  footer note alone is not acceptable — the badge belongs on the panel that
  would otherwise lie.

### Renderer contract

One pure fold: `render(stateAt(cursor))`, where `stateAt` folds
`events + spend_ledger` up to the cursor. **Live is `stateAt(HEAD)` plus an
overlay** (est telemetry, config, board). Replay is not a second UI — it is
the same UI with a different cursor. §9's single reducer is this mechanism;
the overlay is the named boundary.

### Engine follow-ups (all additive; #1–2 filed as #206)

1. **`round-phase` event** — `appendEvent("round-phase", { round_id, phase })`
   beside `advanceRoundPhase` (`round.ts`); without it the hero's phase strip
   cannot replay.
2. **`run-started` event** — appended once at CLI startup, payload carrying
   the resolved-config snapshot (or its hash). Gives replay its run grouping
   and later makes the config drawer historically honest (§10).
3. **Titles in event payloads** (design-director amendment) — `dispatched`
   carries the issue title, PR-producing/merging events carry the PR title,
   read from data the engine already holds at those moments (board query /
   forge response) — never an extra GitHub call. Powers the §3 C hover
   tooltips offline and in replay; older events without the field degrade to
   no tooltip.

New event kinds must land in the §7 copy map in the same PR (gate②
checklist); payload-only additions like #3 need no copy entry.
- **Localization** — the copy map is the seam; add locales when someone asks.
