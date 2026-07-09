# sapwood dashboard — frontend design (v0.2)

Design specification for the v0.2 dashboard (issue #17). This document owns the
*frontend* decisions: product scope, information architecture, visual identity,
motion, copy, and the data contract the UI consumes. [`PLAN.md`](PLAN.md)'s v0.2
chapter owns the *why* and the dogfood/recording plan; it references this file
and duplicates nothing from it.

Status: **design locked for v0.2 implementation issues; pixels may evolve, scope
decisions and the data contract only change by amending this doc.**

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
| 2 | See the agent roles interacting | **IN, real roles only**: conductor, worker, reviewer, merge driver — as actors in the hero scene and lane cards. | The round-orchestrator roles (PO/architect/harvest/retro) have no data yet (`rounds` ledger is unbuilt). The scene layout reserves labeled slots for them; we never render fake state. |
| 3 | Per-node status, output summary, cost | **IN**: lane board from `workers` (+ per-lane cost from `spend_ledger`); header status strip with daily-spend meter. | All columns exist in schema v7 today. |
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
  `paused` / `winding down` / `stopped` — derived from sentinels + ceiling
  breach, §8); daily-spend meter (today vs `cost.dailyBudgetUsd`); the
  Live ↔ Replay toggle.
- **B — Hero: the Loop.** The whole pipeline as one horizontal scene (§6).
  Fixed stage; real events move tokens through it. Ends in the **trunk
  cross-section**: every merged PR accretes one growth ring (§5, signature).
- **C — Lane board.** One card per lane up to `lanes.max`; empty lanes render
  as quiet outlines ("an empty lane is capacity, not absence"). Card: issue
  number + title, state word, PR link when driving, elapsed time, cost so far.
- **D — Activity feed.** The `events` stream through the copy map (§7),
  newest first, relative timestamps; kind-colored dot per entry. Payload
  details (worker, head, mode) collapse behind each entry — never in the
  sentence.
- **E — Cost strip + Config drawer.** Two small SVG bar groups: today's spend
  by lane, and by model (token split available on hover). `Config ▸` opens a
  read-only drawer: resolved config grouped as **Board · Lanes · Worker ·
  Safety · Review & merge · Labels**, each key with its plain-language caption
  (e.g. `worker.budgetUsdSoft` → "Budget per worker — reaching it asks the
  worker to wrap up and hand off, never kills it mid-work").

Empty/error states are directions, not moods: fresh DB → hero idles with
"Waiting for the first dispatch — point sapwood at a Ready issue"; API
unreachable → header flips to `disconnected` with the command to restart;
`needs-human` events pin to the top of the feed until newer than any
escalation.

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
| `--bark` | `#8A7A64` | Muted text, borders, hairlines |
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
contrast in both themes, `prefers-reduced-motion` honored (§6).

## 6. Motion spec — the hero Loop

The hero is a fixed stage (SVG): backlog stack → lane channels (`lanes.max`
of them) → gate ① (checks) → gate ② (review) → trunk cross-section. Roles are
labeled *on the stage itself* in plain words: the conductor is the stage (it
schedules everything); workers are the lane channels; the reviewer sits at
gate ②; the merge driver is the arm between gate ② and the trunk. A reserved,
dimmed slot row above the stage is labeled "planning roles — coming with
rounds" (round orchestrator, unbuilt; never animated).

An issue is a **sap droplet** (amber dot with the issue number). Real events
drive it, via one anime.js timeline per transition:

| Event(s) | Animation |
|---|---|
| `dispatched` | Droplet detaches from the backlog stack, travels into a lane channel (`--travel`); the lane card (§3 C) lights `--sap` in the same beat. |
| lane `running → driving` (from `/state` polling) | Droplet emerges from the lane carrying a PR tag, parks before gate ①. |
| gate progress (`/state`: PR awaiting gate) | Gate ① then gate ② tick `--moss` as CI/review resolve; droplet steps through each. |
| `merged` | Droplet crosses the merge arm into the trunk and **becomes a ring**: a new circle strokes in over 1.2 s, ring counter increments in Fraunces. The one celebratory moment. |
| `handoff` | Droplet folds back into the backlog with a small progress badge ("saved for a successor"). |
| `reclaim-failed`, `reclaim-dead`, `drive-needs-human`, `rollback-escalated` | Droplet stops, flips `--rust`, and pins a marker above its position; no shaking, no bouncing — failures are still, not loud. |
| `ceiling-escalated` / PAUSE / kill switch | Stage dims; ambient sap flow stops; header state word explains. |

Ambient (CSS only): a faint sap shimmer along active lane channels (≥ 3 s
cycle); the current outermost ring breathes at low amplitude while any lane
is running.

`prefers-reduced-motion`: all travel becomes instant position/color swaps;
rings appear without stroke animation; ambient shimmer off. The scene remains
fully legible — motion is commentary, never the only carrier of state.

**Replay mode** drives the identical scene from historical events: a transport
(play/pause, speed ×1/×4/×16, scrub bar spanning the event log) replaces the
polling source. Scrubbing rebuilds state by folding events up to the cursor —
same reducer as live mode, one code path. This is both the "browse past
rounds" feature and the launch demo (replaying the recorded run that built the
dashboard).

## 7. Copy — the plain-language layer

All user-visible sentences live in one module (`copy.ts`), keyed by event
kind. Voice: active, specific, no system internals (say "lane", "checks",
"review", never "reclaim", "tick", "worktree"). The 19 kinds:

| Event kind | Feed sentence |
|---|---|
| `dispatched` | Started work on issue #{issue} |
| `dispatch-failed` | Couldn't start issue #{issue} — it's back in the backlog |
| `reclaim-done` | Lane {worker} finished its work |
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

The same module captions lane states (`running` → "writing", `driving` → "PR
under review", `handoff` → "handed off") and config keys (§3 E). Adding an
event kind without a copy entry is a type error.

## 8. Data contract

Two read-only endpoints, as locked in PLAN.md — both served from the existing
SQLite tables (schema v7, `engine/src/state.ts`); no new engine tables.
Response shapes mirror what `StatusSnapshot` (`engine/src/cli.ts`) already
computes for `sapwood status`.

**`GET /api/loop/state`** — everything current, one poll:

```jsonc
{
  "engine": {
    "state": "running",            // running | paused | winding-down | stopped
                                    // derived: KILL_SWITCH → stopped; ceiling_breach →
                                    // winding-down; PAUSE → paused; else running
    "reasons": [],                  // ceiling_breach.reasons when winding-down
    "lastTickAt": "2026-07-09T08:12:00Z"   // engine_session.last_tick_at
  },
  "lanes": {
    "max": 3,                       // config lanes.max (null if config unreadable)
    "items": [{                     // workers rows, running + driving
      "lane": "w1", "issue": 86, "title": null,   // title enriched client-side is OUT of scope;
      "state": "driving", "pr": 97,               // v0.2 shows numbers, links to GitHub
      "startedAt": "…", "endedAt": null,
      "costUsd": 1.20               // SUM(spend_ledger) per worker
    }]
  },
  "spend": {
    "todayUsd": 12.4,               // dailySpendUsd()
    "dailyBudgetUsd": 100,          // config (null if unreadable)
    "byModel": [{ "model": "opus", "usd": 10.1,
                  "inputTokens": 0, "outputTokens": 0 }]
  },
  "rings": 27,                      // COUNT(events WHERE kind='merged') — the ring count
  "config": { /* resolved config, §3 E; contains no secrets by construction */ }
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

Server: `node:http` on `127.0.0.1` (port configurable, default 4517), SQLite
opened read-only, serves `dashboard/dist` statics plus these two routes. No
POST/PUT/DELETE routes exist — the read-only posture is structural, not
policy.

## 9. Tech architecture

```
dashboard/            # new npm workspace (root package.json already anticipates it)
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
  polling tail, replay feeds it history. The hero, lanes, and feed all render
  from the reducer output — replay correctness falls out for free.
- Launched via a `sapwood dashboard` CLI/slash command that starts the server
  and opens the browser. Read-only DB handle; safe to run beside a live engine
  (WAL mode).

## 10. Deferred (v0.3+)

- **Config editing** — needs a write path + auth story; contradicts v0.2's
  read-only posture.
- **Round-orchestrator views** (PO/architect/harvest/retro, round phases) —
  blocked on the `rounds` ledger; the hero already reserves the slot row.
- **History-aggregation metrics** (cycle time, merge/rework rate) — deferred
  by PLAN.md, gated on GitHub-history work.
- **WebSocket push** — polling at 3 s is indistinguishable for a local
  single-viewer tool; revisit only if a hosted multi-viewer mode ever exists.
- **Issue-title enrichment** in lane cards (needs a GitHub read from the
  dashboard server; v0.2 links out instead).
- **Localization** — the copy map is the seam; add locales when someone asks.
