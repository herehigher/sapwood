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

Amended 2026-07-21 (mockup design rounds — hero + header, third amendment):
the hero's concrete geometry is settled from iterated image mockups (§6): a
horizontal band under three phase captions **PLAN / IMPLEMENT / OUTCOME**,
with the reviewer's push-back drawn as a **fix-loop return arrow** into the
lane and escalation as a **rust branch** dropping out of the checkpoint pair;
the **Live ↔ Replay toggle is removed** — the round navigator *is* the mode
(§3 A, §11); run controls become three tiers **Pause / Stop / Emergency stop** (§3
Operations; emergency-stop engine signal → #293); the light theme returns to a
**cream ground nudged toward sapwood green** (§5, supersedes the pale-green
grounds); a **terminology rule** is added (§7): project-internal jargon never
renders, industry-standard words are first choice. Engine-state precedence is
fixed (staleness beats PAUSE — §8), `/api/rounds` re-anchors on the `rounds`
table (§8), and #206 is upgraded to a **hard prerequisite** for the header
(the run-spend anchor exists only in engine memory today — §11).

Amended 2026-08-14 (dependency-policy review — owner adjudication, #876): §2's "Weight
budget" becomes the **dependency budget** — a fail-closed allowlist test whose *shape*
changed from a standing ban to an owner-adjudicated adoption process; the first
adjudicated toolkit (clsx, lucide-react, the two single-package Radix primitives,
self-hosted JetBrains Mono) is approved in full and recorded in §2's adjudication table.
§5's mono-font ruling is superseded by the same round (self-hosted, no longer
system-stack). This document only establishes the toolkit and the rules; applying it —
module restyling, the icon migration, the `<dialog>` migration, the motion recipes'
application — is #729's work.

Amended 2026-08-14 (#880, #729 fidelity ledger row 3): §3 E's cost strip is rebuilt as two
stacked panels per `cost-dark.png` — "COST · TODAY" (by-stage bars with a shared
target-tick marker + avg-round-cost header) and "COST · ROUND N" (the same by-stage
shape for a closed round, plus by-model breakdown and footer stats), superseding the
single-strip by-model/by-lane first pass. §11's "Cost strip: round tier" text is
superseded — the round panel is now a closed round's frozen summary, never
cursor-truncated by the scrub position.

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
| 1 | Dynamic visual of the whole flow (anime.js) | **IN — the hero.** One animated **closed-loop** scene (§6): phase arc → Backlog → Lanes → Gate ① → Gate ② → rings, returning to Planning. | The promo centerpiece. anime.js (~10 kB) is the single animation dependency, scoped to this scene; all other motion is CSS. |
| 2 | See the agent roles interacting | **IN**: conductor, worker, reviewer, merge driver as actors in the hero scene and lane cards; the round-orchestrator roles (PO/architect/plan review/harvest/retro) as stage nodes on the loop's arcs, lit from live data. | The `rounds` table carries the live phase cursor and `round_artifacts` the per-round history (#123, [round-artifact.md](round-artifact.md)) — the stage nodes render real state, never fake animation. Deep round-browse views stay deferred (§10). |
| 3 | Per-node status, output summary, cost | **IN**: lane board from `workers` (+ per-lane cost from `spend_ledger`); header status strip with the run-tier spend meter (daily ceiling as the secondary readout, §3 A). | Settled (real) cost comes from `spend_ledger` at lane end; **in-flight cost is the engine's #33 estimate** (the pricing.yaml table that already drives the soft worker budget), shown marked `est` and settling to real when the lane ends. |
| 4 | Browse past loop rounds | **IN via replay, not metrics.** The `events` table is a complete append-only history → a replay player (play/pause/scrub) re-drives the whole UI from any point. | History-*aggregation* metrics (cycle time, merge/rework rate) stay **OUT** — PLAN.md defers them to a later phase gated on GitHub-history work. |
| 5 | Config panel | **IN as read-only.** Grouped, plain-language view of the resolved config. **Editing is OUT.** | A config write path would break the dashboard's no-config-writes security posture, and security-relevant config is human-merge-only territory. Edit via the YAML file, where review applies. (The §3 control verbs are the sole, narrower write surface — run-state signals, never config.) |
| 6 | Avoid jargon | **IN as a copy layer**: one map covering **every** event kind — the §7 table is the authoritative list (a hard-coded count here would drift). UI language is English (repo/launch artifact); the map is a single module, trivially localizable later — no i18n framework. | |
| 7 | Spec-first, consistent styling | **IN — this document.** Design tokens (§5) are defined before any component; one CSS file of custom properties is the only styling mechanism. | |

**Dependency budget** (a supply-chain gate, not a weight cap — this section is the
acceptance bar, checked at review). Runtime dependencies land by owner adjudication only;
`dashboard/src/scaffold.test.ts`'s allowlist enforces whatever the adjudication log below
currently says, so a worker cannot widen it without the PR that is supposed to justify it.

Rationale, in priority order:
1. **Supply-chain surface (highest priority).** The allowlist test exists for the same
   reason `guard.ts` exists: an autonomous worker edits `package.json` unsupervised, and
   every dependency it can reach for is an unreviewed second author. Fewer, well-known,
   low-transitive-footprint packages shrink that surface — the same fail-closed
   philosophy `guard.ts` applies to tool calls, applied here to what code runs at all.
2. **Maintenance tax.** A dependency someone else stops maintaining becomes this repo's
   problem; adoption favors actively-maintained, provenance-checkable packages over
   whatever is momentarily convenient.
3. **Bundle size (lowest priority).** Near-irrelevant for a loopback-served, single-operator
   panel — a few KB costs nothing a `sapwood dashboard` user will ever notice. Named last on
   purpose: it is the criterion this budget optimizes for *least*, not the reason it exists.

**Adoption criteria** for a future petition — all of these hold, or the petition names which
don't and why the exception still clears the owner:
- Hand-roll cost is measured in **weeks, not hours** — under that bar, hand-rolling stays
  the default.
- Zero or near-zero transitive runtime dependencies.
- Active maintenance with checkable provenance (real maintainers, real release history).
- Permissive license (MIT/ISC/Apache-2.0 family).
- Tree-shakeable ESM — the allowlist doesn't buy back a bundle explosion.
- No runtime network fetches — offline-safe, the same rule fonts/scripts already follow
  (CDN imports forbidden).
- **Copy-in (below) considered and rejected first** — a dependency is the fallback for
  something dependency-shaped, not the default for a fragment.

**Process.** Adding a runtime dependency is one PR that does all three, together:
1. `dashboard/package.json` + the lockfile carry the exact addition (pinned exact for a
   package without semver discipline this repo trusts, `^` range otherwise).
2. `dashboard/src/scaffold.test.ts`'s allowlist gains the new entry — the test is red until
   it does (a mutation check — temporarily revert the `package.json` line and confirm the
   test goes red — is the way to prove the allowlist is actually load-bearing, not decorative).
3. This section's adjudication log gains one row: the package, the date, and the one-line
   adoption rationale.

Owner adjudication decides the PR; a petition missing any of the three lands nowhere.

**Copy-in (vendoring) channel.** Small, fragment-scale code lifted from elsewhere (one
helper, one algorithm) is a *different* channel from a dependency: it consumes no allowlist
slot, ships as a source file in this repo, and carries a comment naming its source and
license at the top. Vendoring is not a way around the adoption criteria for something
dependency-shaped — it exists for fragments a real dependency would be overkill for.

**Radix usage scope** (owner adjudication 2026-08-14): `@radix-ui/react-tooltip` and
`@radix-ui/react-popover` are scoped to **hover/focus hint surfaces and their positioning —
flip/collision placement — only**. Every other interactive surface (drawers, confirm flows,
buttons, the config panel) stays native markup; reaching for either package outside that
scope is a scope violation, not a convenience call a component author gets to make alone.

**Adopt-later triggers** (not adopted; recorded so a future petition points at a concrete
bar instead of re-litigating the rationale from zero):
- **uPlot** — only once time-series spend charts exceed ~500 points (v0.3+ territory);
  hand-rolled SVG stays the answer below that.
- **@tanstack/react-virtual** — only if the 200-row feed render cap ruling is overturned;
  virtualization solves a problem the cap currently prevents from existing.
- **motion** (the Framer Motion successor) — only on a layout-level shared-element
  animation need that neither CSS nor anime.js (scoped to the hero, §2 row 1) can express.

| Budget item | Status |
|---|---|
| Chart library | none — cost bars/sparklines are hand-rolled SVG |
| CSS framework / CSS-in-JS | none — `tokens.css` + `app.css`/`panels.css`/`hero.css`, plain CSS only |
| Server | `node:http` + `node:sqlite` (read-only), 127.0.0.1-bound; no Express. One guarded `POST /api/control` route (§3 Operations) — sentinel writes only |
| Transport | HTTP polling (3 s via TanStack Query); no WebSocket |
| Fonts | two self-hosted faces, woff2, CDN forbidden (display: Fraunces, hand-subset latin woff2; data: JetBrains Mono Variable, the `@fontsource-variable/jetbrains-mono` package's own CSS, §5); system stack for body |

**Adjudication log** (owner adjudication 2026-08-14 unless noted — every runtime addition
*and* every no-new-dependency ruling gets one row; this is the durable record the process
above points at):

| Date | Item | Rationale |
|---|---|---|
| 2026-08-14 | `clsx` (runtime) | State-variant class composition; 0 transitive deps, ~0.35 kB. |
| 2026-08-14 | `lucide-react` (runtime, pinned exact) | Utility icons only — identity glyphs (sap droplet, rings, issue ⊙, PR merge-arrow) stay hand-drawn permanently (§3 C, `icons.tsx`); the unified icon spec lives in `icons.tsx`'s header. A new icon import gets its own table mention at adoption. |
| 2026-08-14 | `@radix-ui/react-tooltip` + `@radix-ui/react-popover` (runtime, single packages — not the umbrella) | Keyboard-accessible, stylable tooltips are a §5 quality-floor requirement the current `title=` approach violates; flip/collision positioning is genuinely hard to hand-roll and CSS anchor positioning isn't cross-browser green yet. Usage scoped per the clause above. |
| 2026-08-14 | `@fontsource-variable/jetbrains-mono` (runtime) | Self-hosted mono face, imported whole via the package's own `index.css` (`main.tsx`) — re-adjudicates §5's system-stack ruling (its zero-dependency premise is overturned this round); Fraunces's self-hosted/CDN-forbidden posture is the precedent this follows, not Fraunces's own hand-subsetting mechanism (§5 amendment explains why). |
| 2026-08-14 | anime.js stays the single animation engine, scoped to the hero — **no new dependency** | Micro-interactions move to CSS-native recipes instead: a `--tap` motion token plus `@starting-style` + `transition-behavior: allow-discrete` recipes for drawer slide-in / list-entry appearance / press feedback (`panels.css`) — no bare millisecond value in a component. |
| 2026-08-14 | Drawers/confirm dialogs → native `<dialog>.showModal()` — **no new dependency** | Focus trap, Esc, backdrop, and `inert` come free from the platform; the current hand-rolled drawers lack a focus trap. The hold-to-arm reducer and its semantics are untouched by this ruling. |
| 2026-08-14 | No chart library — **re-affirmed on merits** | The hatch-fill est/settled encoding is a frozen-mockup identity element any chart library fights. Cost bars converge on one shared `<CostBar>` component + one SVG `<pattern>` hatch def (`--hatch-*` tokens); a `.num` utility class (`font-variant-numeric: tabular-nums`) covers all monetary/count text. |
| 2026-08-14 | No CSS tooling additions (open-props / CVA / capsize / extra PostCSS) — **rejected** | `tokens.css` is extended instead (`--tap`, `--focus-ring`, `--z-drawer`/`--z-dialog`, `--hatch-*`) rather than reaching for a tool to manage tokens `tokens.css` already manages directly. |
| 2026-08-14 | uPlot / `@tanstack/react-virtual` / motion — **not adopted, adopt-later triggers recorded** | See the adopt-later triggers above for the exact reopening condition per package (time-series spend past ~500 points / the 200-row feed cap ruling overturned / a layout-level shared-element need neither CSS nor anime.js can express) — none is met today. |
| 2026-08-14 | `@playwright/test` — devDependency, outside the runtime allowlist | `npm run shots`: renders the `?demo` fixture at 1440/1024/720 × both themes into a static side-by-side contact sheet (frozen mockup vs. live capture) — no pixel-diff assertions, evidence for humans and gate② (`docs/dev-guide/07-dashboard.md`). |
| 2026-08-14 | `@testing-library/react` — devDependency, outside the runtime allowlist | Real interaction testing alongside the existing `registerRealDom()` opt-in pattern (`docs/dev-guide/07-dashboard.md`). |
| 2026-08-17 | `lucide-react`'s `Sprout` icon (#921, zero-ring sapling glyph) — no new dependency, new import off the existing `lucide-react` allowlist row | Owner ruling: standard resources first — hand-draw only what has no standard equivalent. The sapling is the one exception to the identity-glyph-set's own "hand-drawn permanently" rule (`icons.tsx`'s header, sap droplet/rings/⊙/merge-arrow) — a sapling has no bespoke visual metaphor to protect the way those do, so `Sprout` (`stage.tsx`'s `.hero-sapling`, coloured via `--moss`) is sourced instead of hand-drawn. |

This issue (#876) lands the toolkit and the rules above; applying any of it — module
restyling, the icon migration, the `<dialog>` migration, attaching the motion recipes — is
out of scope here and belongs to #729.

## 3. Information architecture

Single page, no routing. Five modules, one screen — plus a slim left **icon
rail** (~56 px) that is pure chrome, not navigation: wordmark at top, anchor /
drawer entries (overview, cost, config) and the theme switch, config gear at
bottom. Rail items scroll or open drawers on this one page; the moment a rail
item becomes a routed page, that is a scope amendment to this section.

```
┌──────────────────────────────────────────────────────────────┐
│ ◉ sapwood   ● running   ◂ round 12 ▸   spend ▓▓░ $12 / $100  │  A header
├──────────────────────────────────────────────────────────────┤
│   PLAN               IMPLEMENT                   OUTCOME     │
│   Goal&align→Arch review→Verify                              │  B hero
│  Backlog ─▶ ┃lane┃lane┃lane┃ ─▶ CI ─ Review ─▶ ◎rings       │  (closed
│                ╰◀╌ fix loop ╌╯     ╰▼ needs human            │   loop)
│      ╰╌╌╌╌ dashed return ◀╌ Summary · Retro ╌╌╌╌╯            │
├───────────────────────────────────┬──────────────────────────┤
│ C lanes                           │ D activity               │
│ ┌────────┐ ┌────────┐ ┌────────┐  │  Merged PR #94           │
│ │ #86 ●  │ │ #88 ◐  │ │ (idle) │  │  Lane 2 handed off       │
│ │ $1.20  │ │ PR #97 │ │        │  │  Started issue #90       │
│ └────────┘ └────────┘ └────────┘  │  …                       │
├───────────────────────────────────┴──────────────────────────┤
│ E cost · today / cost · round N (by stage, by model)  [Config ▸]│
└──────────────────────────────────────────────────────────────┘
```

- **A — Header.** Wordmark; engine state as one word + dot (`running` /
  `standby` / `stalled` / `paused` / `winding down` / `stopping` / `stopped` —
  derived from sentinels, ceiling breach, standby events, and `lastTickAt`
  age, §8; `standby` renders calm, never as an error — #723: a standby
  backoff dwell deliberately stops ticking, so a FRESH standby signal
  overrides tick staleness rather than misreading a healthy dwell as
  `stalled`) with its §7 plain-language caption next to it (`standby`'s
  caption folds in the next-check countdown, e.g. "checking again in 42s");
  the spend meter —
  **run-cumulative vs the per-run stop budget** (`stop.afterSpendUsd`, the
  #154 run-scoped ledger sum): numerator and denominator must always come
  from the **same budget tier** (§11); with no run budget configured the
  meter falls back whole to the daily tier (today vs `cost.dailyBudgetUsd`),
  never a mixed-tier fraction. The daily hard ceiling — the line that
  actually stops the engine — moves behind hover, **auto-surfacing with a
  warning tint once its usage crosses ~75%** (a non-binding constraint is
  noise; a binding one is information). The est tail renders in live view
  only — history has only settled cost (§11).

  Display vocabulary collapses for the glance: `standby` + env-park render
  as **waiting** (park adds a small sub-caption), `winding down` +
  `stopping` as **stopping**; full internal states live in the tooltip.
  The dot is static — the hero already breathes; the word is the signal,
  the dot its punctuation.

  **There is no Live ↔ Replay toggle** (2026-07-21 amendment). The **round
  navigator is the mode**: `◂ [round N] ▸` — the rightmost position is a
  permanent **LIVE slot** showing the open round ("round 12 · executing")
  or, when none is open, the engine state itself ("live · waiting", "live ·
  stopped"; fresh DB → "no rounds yet" with the §3 empty-state direction).
  Stepping left enters a closed round and the whole page replays it (§11).
  Clicking the round number opens the round list: one row per round —
  id · date · merged-PR count · spend — closed rows prefixed with a small
  ▶ glyph (the replayability affordance; the list doubles as the history
  ledger). Whenever the view is not at LIVE, a "back to live" jump stays
  visible, and the header carries a persistent tinted **"ROUND N · CLOSED"**
  badge. `◂`'s hover tooltip reads "replay round N−1". Scrubbing *within*
  the open round is deliberately not offered in v0.2 (§10).
- **B — Hero: the Loop.** The whole pipeline as one **closed loop** (§6):
  round phases arc across the top, the worker pipeline runs through the
  middle, harvest/retro return along the bottom back to PO. Fixed stage;
  real events move tokens through it. The worker pipeline ends in the
  **trunk cross-section**: every merged PR accretes one growth ring (§5,
  signature). Stage nodes are clickable — the phase inspector (§6).
- **C — Lane board.** One card per lane up to `lanes.max`; empty lanes render
  as quiet outlines ("an empty lane is capacity, not absence"). Card: issue
  number (linking to GitHub), state word, PR link when driving, elapsed time,
  the lane's model·effort caption (mono, e.g. `opus · high` — the
  **configured** value from the config allowlist, not live telemetry), and
  cost — the engine's in-flight **estimate** (marked `est`, #33) while
  running, settling to the `spend_ledger` real sum when the lane ends.

  **Issue/PR numbers — everywhere they appear** (lane cards, feed, hero
  droplets, ring tags): (a) a **type glyph** distinguishes them at a glance —
  issue = circle-dot ⊙, PR = merge-arrow, inline SVG, never color as the
  sole carrier (§5); (b) **hover shows the title** where one is known. The
  reducer remembers each entity's title from the first **title-bearing
  event** it folds (`dispatched` carries the issue title; the PR-open
  transition and `merged` carry the PR title — #207); the dashboard never
  queries GitHub for titles, so tooltips work offline and in replay. A
  number whose entity has no title-bearing event — pre-dispatch mentions in
  the feed (`plan-review-escalated`, `verify-na-proposed`, …) and all
  pre-#207 history — simply shows no tooltip; that bounded blind spot is
  accepted, never patched with a live lookup.

  Owner ruling Q3, 2026-08-17 (#729 design review; tracked by #926, not yet landed): lanes take
  one full-width row above the activity feed (`lanes-dark.png`'s 3-card composition), replacing
  this section's current C|D half-split — the feed renders full-width below once #926 lands.
  The diagram and the C/D bullets above are the pre-#926 state; the IA-diagram/boundary edit is
  #926's own.
- **D — Activity feed.** The `events` stream through the copy map (§7),
  newest first, relative timestamps; kind-colored dot per entry. Payload
  details (worker, head, mode) collapse behind each entry — never in the
  sentence.
- **E — Cost strip + Config drawer.** Two independently framed panels, stacked (#880,
  `cost-dark.png`; supersedes the single-strip by-model/by-lane first pass and §11's
  now-superseded "round tier" strip text below) — each its own bordered card, never one shared
  card with an internal divider. **"COST · TODAY"**, always present: a **by stage** group (§7
  labels — goal & align / arch review / verify / lanes / summary / retro, never the internal phase
  keys; zero-filled, fixed order, six rows always). LIVE mode sources it by UNIONING every round
  that started TODAY (the wall-clock UTC calendar day) own full, uncapped log (the same durable
  per-round fetch §3 E's round panel below already uses for a single round) — never the bounded
  live display tails (`events`/`spend` history caps), which could otherwise silently misclassify or
  drop a still-real row once it ages past either cap's own eviction point. `?demo` has no live
  "today" of its own — the WHOLE static fixture (`events`/`spend`/`rounds`, never capped at all)
  stands in for it wholesale, so every round the bundle carries counts, regardless of the fixture's
  own fixed recording date (day-filtering a static demo by wall-clock date would silently empty it
  the moment the shipped recording ages past its own day). Both modes render through a shared
  **target-tick marker** — one value (the currently configured `cost.roundBudgetUsd`, spread evenly
  across the six stages — no per-phase budget exists to draw on) drawn at the same coordinate on
  every bar in the group, since they share one `max` — plus a **by model** group (the
  server-aggregated today total in live mode, already unbounded; the bundle's own total in demo),
  and an **avg-round-cost** header stat (mean settled spend across that SAME today-scoped round set
  the by-stage group unions — live: today-started rounds; demo: the whole bundle). **"COST · ROUND
  N"**: the same by-stage/by-model shape for a specific
  CLOSED round — live mode's last-closed round when nothing is selected in the navigator, or the
  navigator's own selection in replay — carrying a **CLOSED** badge, its own target tick (that
  round's OWN persisted `roundBudgetUsd`, never today's live config), and a **footer** line: total
  spend / PRs merged / $-per-PR read straight from the round's persisted artifact, and review cost
  summed from that round's OWN `spend_ledger` rows (`actorKind: "engine-review"` — the artifact
  carries no review-cost field of its own) — the whole footer omitted, never fabricated, when the
  artifact is missing or malformed. This round panel reads the round's FULL log, never truncated by
  the replay scrub cursor — it is a closed round's frozen summary, not a moment-by-moment view like
  the hero/feed panels beside it. Phase, not lane, for the by-stage group: lanes are short-lived
  reused slots (w1/w2/w3), so a by-lane aggregate carries little meaning — per-lane cost already
  lives on the lane cards (§3 C).
  `Config ▸` opens a read-only drawer: an **allowlisted subset** of the resolved config (the
  server serves named keys, never the whole object — the no-secrets guarantee
  stays structural even if future config grows sensitive keys; the allowlist
  **must include** the per-role `model`/`effort` keys the §3 C/§6 captions
  read), grouped as
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

**Needs attention strip** (design-director round 2 — the target-user
review's strongest ask): a conditional strip between header and hero,
rendered **only** when something needs a person — zero height otherwise, so
the calm default stays calm. It is the promoted form of the old
"`needs-human` pins to the top of the feed" rule, upgraded from a feed
convention to a first-class surface. One row per open item, each showing:
a **category chip** (#881 — `ATTENTION_CATEGORY` in `copy.ts`: one of
DECISION / LANE END / FIX CAP / CEILING / ROLLBACK / INSPECT / ENV / REVIEW /
LABEL / CI, one entry per attention kind, no fallback for an unmapped one),
the affected entity (issue/PR number with its type glyph and hover title),
the plain-language reason clause **and explicit "asks:" action** (the same
§7 copy map sentence that produced the feed line — no second vocabulary; an
attention sentence names why the row exists and what a person is meant to
do about it, or states "reason not recorded" when the engine payload
genuinely carries no reason field yet rather than fabricating one — #881's
payload audit), *when* (in a bordered age box), and — **only when the
payload carries it, verbatim fields, never synthesized** — what the engine
did about it. Each row links to the GitHub issue/PR and opens the relevant
inspector drawer on click.

Membership is carried by the copy map, not a second list — and it is
defined **semantically, not by sentence wording**: a kind whose event
*leaves work waiting on a person* carries an `attention` field on its
`copy.ts` entry, either `true` or a **payload predicate** for kinds where
only some payloads qualify (the entry owns its own condition — no side
list to drift, and gate②'s existing extend-the-map checklist item curates
the flag with the sentence). Flagged today: `drive-needs-human`,
`drive-no-pr`, `fix-rounds-capped`, `fix-leg-verdict-rerun`,
`rollback-escalated`, `plan-review-escalated`, `verify-na-proposed` (#296 —
the gate⓪ "not separately verifiable" proposal: labels and comment land
automatically, but only a person accepts or rejects it; issue-scoped, so the
existing issue-scoped clears below resolve the row), `gated-reentry-capped`,
`gated-reentry-capped-label-failed`, `worktree-retained`,
`park-escalated`, `env-failure-preserved` (that path deliberately leaves
the lane failed — the preserved PR needs a manual drive),
`ceiling-escalated`, `ci-inert-escalated`, `ci-pending-escalated`; plus two
predicate kinds: `reclaim-failed` when
`payload.next` is not an automatic continuation, and `reclaim-done` on its
no-PR branch — that condition is **code, not prose** (#404): the engine's
`attentionProof(kind, payload)`
(`engine/src/loop/escalation-reconcile.ts`) owns it, the reconciler and the
label sweep both read it, and the strip's fold imports it rather than
re-encoding the sentence above a third time. (A lane whose PR keeps driving is not an open item; a clean
`reclaim-dead` requeue is not either — its human case arrives separately
as `worktree-retained`.) The `stalled` / `disconnected` engine states add
**entity-less** rows: the state word plus its §3 remedy direction, no
issue/PR.

Attention items fold over the **whole event history, not the current
run** — a restart must not empty the strip while the human task remains
(the strip answers "does anything need me?", and an uninspected folder
still does). Clearing uses only events that actually resolve the item:
issue-scoped items (including `ceiling-escalated`, which the engine emits
**per hard-stopped worker**, and `env-failure-preserved`) clear when a
later event moves that issue (`dispatched`, `merged`, `gated-reentry`,
`lane-revived`, and — #933 — the two engine terminal witnesses
`human-merge-only-closed` and `gated-lane-retired`, which retire
`drive-human-merge-only`/`gated-flag-unprovable` the same way a merge or a
reentry retires anything else) — with one exemption: a clear event never
clears an escalation **that same operation produced**, because an
operation's own effects are not evidence it was resolved (a merge whose
Done-board write failed emits `rollback-escalated` *before* its own
`merged` event; the board is still wrong) —
**or, since #295, when `escalation-resolved` reports the human resolved it
outside the loop entirely.** That event is what makes the empty-strip
contract survivable: the 2026-07-21 audit found most escalation classes had
no clearing path at all (`gated-reentry-capped`,
`gated-reentry-capped-label-failed`, merged-path `rollback-escalated` and
`drive-needs-human` with `labeled: 0` are one-way
latches; `resume-capped`, `resume-undecidable`, `ceiling-escalated`,
`env-failure-preserved` and the no-PR escalations cleared only on a
re-dispatch that a hand-merge or a hand-closed issue never triggers), so a
zombie row could sit on the strip forever and teach the operator to ignore
it. A per-round read-only reconciler now observes external forge truth and
appends the event once per resolution, keyed `(source, issue)` for the
fold. Two honesty limits the strip inherits: `via: "label-removed"` is only
emitted for escalations that **provably applied** the label (otherwise a
failed label write would read as a human clearing it — a false empty strip,
worse than a zombie row), and `via: "board-fixed"` exists for exactly one
class — the merge-produced `rollback-escalated`, whose meaning *is* "the
Done-board write never landed", so the board column is the only honest
witness (its issue was closed by the same merge's `Closes #N`, which is why
closure cannot clear it). It costs one board-wide placement read per sweep,
taken only when such an escalation is open. `park-escalated` clears on
`park-resumed`; round-scoped escalations clear
when their round closes; `stalled`/`disconnected` clear when polling
recovers. `worktree-retained` clears on `worktree-released` — a new
**additive** engine event (follow-up #210, alongside
the `dashboard.controls` schema key): the engine already owns the retained
path, so on tick/startup it notices the folder is gone (the human cleaned
it up) and appends the event; the filesystem it manages is the resolution
signal, no acknowledge UI invented. The strip never invents state and
never requires an acknowledge action. In replay it rebuilds from the same
fold at the cursor, like every other event-backed surface (§11).

The issue-scoped clear SET itself (#933) is **derived from the engine's own
registry**, not hand-mirrored on the dashboard side: every kind the engine
tags `escalation-clear` (`engine/src/state/event-kinds/*.ts`) is, by
construction, in `dashboard/src/entities.ts`'s `ISSUE_CLEAR_KINDS` — the
dashboard reads the tag (`kindsTagged("escalation-clear")`) rather than
re-listing kind names by hand. Before #933 the list was a literal array a
human had to remember to update every time the engine grew a new terminal
witness, and `human-merge-only-closed`/`gated-lane-retired` fell through
that gap for weeks (54 zombie rows on the dogfood DB, oldest from
2026-07-29) — deriving the set means the next terminal kind the engine
tags cannot fall through the same way.

**Operations — start · pause · resume · stop · e-stop** (design-director
round 2, user decision; e-stop added 2026-07-21): the release dashboard is
no longer a pure spectator — the engine-level verbs get UI entry points in
the header, next to the engine state word they act on. The **data surface stays read-only**; the
verbs are the *only* write path, and they write nothing but the engine's
own control signals:

| Verb | Meaning (existing engine semantics — nothing new invented) |
|---|---|
| Pause | Create the PAUSE sentinel: lanes finish their current work, nothing new dispatches. |
| Resume | Remove the PAUSE sentinel; the next tick continues the run. |
| Stop | Create the kill-switch sentinel — the PLAN.md safety tier, described honestly: active lanes get the bounded drain window (`cost.drainWindowSec`) to finish or hand off; a lane still running after it is hard-stopped by the engine. Drain-first with the existing hard backstop — the dashboard adds no new stop mechanism and must not promise a softer one than the engine has. |
| Start | Clear stop/pause sentinels so the next tick runs. If the engine *process* is dead, the dashboard cannot spawn it — the button flips to showing the CLI launch command instead (honest boundary; process supervision is not a browser feature). |
| Emergency stop | **Immediate hard stop, no drain window** — every running lane's process group is killed at once; in-flight work is lost and lanes escalate `needs-human`. Requires the additive `EMERGENCY_STOP` engine sentinel (#293, `type:security`, human-merge-only) — **landed** (sentinel #724, button+verb #733); the button renders only while the engine is actually running (verb-legality). Verified 2026-07-21: the existing kill switch is drain-first by design (SIGTERM handoff requests, hard kill only past `cost.drainWindowSec`), so Stop ≠ Emergency stop and the UI must never describe either tier as softer or harder than the engine's actual behavior. **Label rule (2026-07-21):** the button reads **EMERGENCY STOP** spelled out — the industrial abbreviation "E-STOP" is standard on hardware (ISO 13850) but misreads as "E-SHOP" at small type in a web header, and the full form matches the engine signal name exactly. It carries a small **octagon outline icon** (stop-sign shape) — the page's only icon-bearing control button and, like rust, page-unique; Pause/Stop stay text-only (the asymmetry *is* the tier hierarchy). |

**Misfire protection is mandatory**: every verb is two-step — the control
opens a confirm that names the consequence in §7 plain language ("Stop —
lanes get the drain window to finish or hand off; any lane still running
after that is stopped hard"), with the
confirm action requiring a deliberate second click; Stop additionally arms
only after a short hold, and **releasing the hold cancels — armed is never
"release to fire"**. Emergency stop gets both: hold-to-arm plus a confirm that
names the consequence verbatim ("in-flight work is killed, WIP may be
lost"), rendered rust and visually isolated from Pause/Stop by a hard gap —
Pause and Stop themselves keep spacing (the 20-px-hover-slip accident is a
design input, not an edge case).

Two placement rules (2026-07-21): the verbs are **hidden entirely while
viewing a closed round** — they act on the present engine while every other
pixel shows an as-of-cursor past, so rendering them invites acting on stale
evidence; the "back to live" jump is the way back to them, rendered in the
header row itself in their place. And the replay transport (§11) must
**never share position or icon language** with these verbs: transport =
media glyphs in its own strip, engine verbs = text buttons at the header's
right — otherwise leaving replay swaps a media ⏸ for an engine STOP under
the same cursor position. **The strip is the header card's own second row**
(2026-08-18 amendment, #923, `header-dark.png`): the transport renders
inside `.app-header`, under a hairline separating it from the engine-status/
verbs row above, rather than as a separate panel stacked below the header.
While a verb is taking effect the header shows the engine's real
transition state (`winding down`, `stopping` — §8 derivations, not an
optimistic flip); controls disable during transitions. Buttons reflect
validity (Resume only while paused, etc.). Server side this is **one**
allowlisted `POST /api/control {verb}` route (§8) — sentinel files only, no
DB, config, or GitHub writes. The route defends itself **server-side** — a
UI confirm binds nobody: it requires `Content-Type: application/json` plus
a custom `X-Sapwood-Control` header (a cross-origin page hits a CORS
preflight the server never grants) and rejects requests whose `Origin`
header, when present, is not the dashboard's own. `dashboard.controls`
defaults to **true** — the release decision is that operators get these
verbs out of the box — and `false` removes the route and the buttons
entirely; the key is new to the (strict) config schema — engine follow-up
#210 (PAUSE `#75` and the kill switch already exist; only the
schema key is new). Config *editing* stays out (§2 #5,
§10) — flipping a documented run-state signal the engine already honors is
a different risk class from mutating reviewed YAML.

Empty/error states are directions, not moods: fresh DB → hero idles with
"Waiting for the first dispatch — point sapwood at a Ready issue"; API
unreachable → header flips to `disconnected` with the command to restart;
config unreadable (`lanes.max` null) → hero draws a single placeholder channel
captioned "lane count unknown — config unreadable"; `needs-human` events land
in the Needs attention strip (above) rather than pinning inside the feed.

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

Owner ruling Q1, 2026-08-17 (#729 design review; implemented by #921): ring-disc honesty over
constant-footprint mimicry — the count stays strictly one ring per merge (no phantom base
grain), and the zero-merge state opens with a small sapling glyph in place of an empty disc
(§6 zone 4's `TRUNK`/`ringRadii` growth rule, `stage.tsx`). The mockup's always-full disc and
this section's "the rings are the record" pulled opposite ways at low counts; honesty won.

## 5. Design tokens

One `tokens.css`; both themes derive from the same names. Dark ("heartwood")
is the default — it is a monitoring surface — with a light ("sapwood") theme
via `prefers-color-scheme` and a manual override.

**Color** (dark theme values; light theme swaps grounds and darkens accents
one step for contrast). The light theme's grounds (re-decided 2026-07-21,
supersedes the pale-green ruling after side-by-side mockup review): **warm
cream nudged toward sapwood green** — a cream base with a faint green
whisper, not white, not saturated green, not the earlier milky pale green.
Owner adjudication over rendered candidates: pure pale-green grounds read
wrong in practice; the cream-with-green-tint keeps the "spring on warm
paper" mood while still carrying the sapwood identity. Success stays the
deeper teal-green (moss loses signal on warm light grounds), and **every
text-on-ground pair is re-checked for WCAG AA per theme** (the §5 quality
floor already requires this; the palette shift makes it load-bearing, not
pro-forma).

Light-theme starting values (#143 implements these; AA-verify each pair with
a contrast tool at implementation and adjust the failing side, per the
quality floor): ground `#F1F0E2` (cream, green whisper), panel `#E9EAD6`
(one step greener), primary text `#251B10` (heartwood, reused), muted text
`#57604A`, accent amber as text/fill `#8A5A14`, success `#3E6B4F`
(teal-green), failure `#A34620`. Borders keep `--bark`. Dark-theme values
below are unchanged:

| Token | Hex | Role |
|---|---|---|
| `--heartwood` | `#251B10` | Background — warm dark brown, not near-black |
| `--panel` | `#2E2317` | Cards, drawer |
| `--sapwood` | `#F1E7D2` | Primary text (dark theme) / background (light theme) |
| `--bark` | `#8A7A64` | Borders and hairlines **only** (≈3.9:1 on `--heartwood` — below AA for text) |
| `--bark-text` | `#A6957C` | Muted text (AA-passing on both grounds) |
| `--sap-text` | `#E8A33D` | Amber — the *activity* color, stroke/text/outline role: flowing tokens, running lanes, spend meter, focus ring |
| `--sap-fill` | `#E8A33D` | Amber, filled-surface role: chips, droplets, bar pills, filled buttons — flat, same value both themes (see amendment below) |
| `--on-sap-fill` | `#251B10` | Ink drawn ON a `--sap-fill` surface — always dark, since `--sap-fill` no longer darkens for light theme |
| `--moss` | `#8FA36B` | Success: merged, CI green, healthy engine dot |
| `--rust` | `#D9713F` | Failure/escalation: failed lanes, `needs-human`, ceiling breach |

Amended 2026-07-24 (#143, token implementation): the dark `--rust` moved from the
originally-specced `#C05A2E` to `#D9713F`. `#C05A2E` measures 3.82:1 on
`--heartwood` and 3.46:1 on `--panel` — below AA as text, and `--rust` *is* text
("failed", "needs human"). The quality floor's "adjust the failing side" rule
applies; `#D9713F` is the same hue one step lighter and clears AA on both grounds
(5.14:1 / 4.66:1). All 20 text-on-ground pairs now pass — `npm run contrast -w
dashboard` prints the table, and `dashboard/src/tokens.test.ts` fails the build if
any pair regresses. Both themes live in a single `light-dark(light, dark)`
declaration per token, so a theme cannot silently drift from its twin.

Rules: amber means "in motion", `--moss` means "done well", `--rust` means
"a person should look" — never decorative use of any of the three. Rings are
stroked in `--bark` at 40% alpha; the growing (current) ring in `--sap-text`.

Amended 2026-08-17 (#924, #729 remainder D32/Q5): `--sap` split into `--sap-text`
(stroke/text/outline role — unchanged value, `light-dark(#8A5A14, #E8A33D)`, still
darkening for light theme) and `--sap-fill` (filled-surface role — chips, droplets,
bar pills, filled buttons — a flat `#E8A33D` in BOTH themes, no longer light-dark).
No alias for the old `--sap` name (pre-v1) — every site re-pointed by role. The flat
`--sap-fill` no longer darkens for light theme the way `--sap-text` does, so it
measures only 1.88:1 against the light-theme page ground (`--heartwood`), below the
WCAG 3:1 non-text boundary (dark theme clears it at 7.83:1) — every filled
`.hero-pool-chip`/in-motion-droplet/`.spend-meter-bar` fill compensates with a 1px
`--sap-text` outline in light theme only (`--sap-fill-outline`, tokens.css;
`hero-panel-light.png`'s own drawn fill/outline treatment). `--on-sap-fill` (the ink
drawn on a filled surface, e.g. `.hero-pool-chip`'s issue number) is a fixed `#251B10`
rather than a `light-dark()` alias of `--heartwood` — `--heartwood`'s own light-theme
value is the PALE ground color, which would read as light-on-amber against the now
constant-bright `--sap-fill` and fail AA (1.88:1); a fixed dark ink clears AA (7.83:1)
in both themes since `--sap-fill` no longer varies. `npm run contrast -w dashboard`
prints both the existing text-on-ground table and this fill/outline accounting.

**Type** — three roles, one bundled file:

| Role | Face | Use |
|---|---|---|
| Display | **Fraunces** (subset woff2, bundled — offline-safe) | Wordmark, section labels, the big ring count. Used sparingly; its warmth carries the organic identity. |
| Body | `system-ui` stack | All UI prose. Native feel, zero bytes — the honest choice for a local tool. |
| Data | **JetBrains Mono Variable** (self-hosted npm dependency — see the 2026-08-14 amendment below), `ui-monospace` stack as fallback | Issue/PR numbers, costs, timestamps, config keys. A tool dashboard is mostly data; the mono face does the daily work. |

Amended 2026-08-14 (§2 dependency-budget review, owner adjudication, #876): the Data
role's face changes from the bare `ui-monospace` system stack to **self-hosted JetBrains
Mono** via the `@fontsource-variable/jetbrains-mono` runtime dependency — `main.tsx` imports
the package's own `index.css` unmodified (its every subset/weight for the `wght` axis, woff2,
CDN imports forbidden — same rule bundled fonts already follow). §2's own priority order
governs the choice not to hand-subset this asset the way Fraunces's own woff2 is: the owner
adjudicated the *package*, and re-deriving a latin-only cut from it would trade a real
dependency relationship (the lockfile pins what ships) for a vendored copy wearing the
allowlist's slot — exactly the copy-in-channel confusion §2's own copy-in rule warns against,
and in service of bundle size, the criterion §2 ranks lowest. This supersedes this section's
prior system-stack-only ruling: that ruling's zero-dependency premise is what §2's round
overturns — a mono face is now inside the adjudicated toolkit, the same way Fraunces already
is self-hosted (subset woff2, bundled, CDN forbidden) — the self-hosted/CDN-forbidden posture
is the precedent this follows, not the specific hand-subsetting mechanism. The system
`ui-monospace` stack stays as the fallback for the font-load window and any environment the
woff2 fails to reach — `--font-data` (`tokens.css`) leads with `"JetBrains Mono Variable"` and
keeps the full prior stack behind it.

Adjudicated 2026-08-10 (#728, token adjudication): the h1/h2/h3 module headers (`app.css`)
and the hero's PLAN/IMPLEMENT/OUTCOME captions and ring count (`hero.css`) render in
**Fraunces**, the display face above — this row already blessed exactly that use ("section
labels, the big ring count"). The #144 and #145 gate② frozen-baseline probes (`hero-panel-*`,
the dashboard concept renders) both recorded the shipped headers as a deviation because the
baseline mockups render all-mono; both probes filed it as non-blocking and pointed at one
shared adjudication rather than two. Ruling: the token table stands as specced — Fraunces for
display headers — and the baseline PNGs are the out-of-date artifact, not the implementation.
**Scope: FONT FAMILY only** (owner ruling Q2, 2026-08-17, #924/#729 remainder) — this entry
never spoke to casing, letter-spacing, or scale; those follow the mockups directly (uppercase,
letter-spaced, ~16–18px at 1440 — `.panel-head`, panels.css) and are #924's own scope, not a
reopening of this one. No code change follows from this #728 entry itself; it exists so
#144/#145's "recorded for adjudication" deviation has a resolved answer on file.

Node labels inside the hero stage — outside #728's own scope too — render `--font-data`
uppercase below their node (§6 zone descriptions; tracked by #922, not yet landed); every
panel's title row shares one anatomy: title + right-aligned stat cluster + hairline rule
(`.panel-head`, panels.css — implemented by #924).

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

**Process note** (#729 design review, 2026-08-17): a design-fidelity issue's ACs carry a
mockup/live crop pair as their own oracle — element-present or token-exact alone is never
finish evidence (REVIEW-DOCTRINE.md's STRUCTURE-AS-FINISH sub-case).

## 6. Motion spec — the hero Loop

The hero is a fixed stage (SVG) drawn as a **closed loop** — the loop is the
semantics; the concrete geometry was settled 2026-07-21 through iterated
image mockups as a **horizontal band, four zones left → right, closed by a
dashed bottom return path** into the planning zone. Three small uppercase
phase captions span the top: **PLAN** (backlog + planning columns),
**IMPLEMENT** (lanes + checkpoints), **OUTCOME** (rings + reflection). Role
words (producers ≠ reviewers ≠ mergers) no longer caption the stage — the
separation is carried by geometry (the checkpoints sit outside the lanes;
the merge arm answers only to review) and the role vocabulary lives in the
"?" legend (§7).

The four zones:

1. **Backlog** (narrow, same width as planning): title `BACKLOG (7 ready)` —
   count in the title, live-only, linking out to the board. Below it this
   round's **selection pool** from `pool-selected` events (replayable):
   selected chips amber-filled and floated to the top, candidates as dim
   outlines beneath.
2. **Planning**: three nodes stacked vertically — **GOAL & ALIGN**
   (`aligning`), **ARCH REVIEW** (`architecting`), **VERIFY**
   (`plan_review`; the verification-plan gate — "no plan, no dispatch" is
   its hover) — icon inside a hairline circle, label outside below, the
   active phase carrying a soft pulse halo, with the staleness caption
   ("last event 14s ago") under the group.
3. **Work lanes + fix loop** (the centerpiece, ~45% width): `lanes.max`
   horizontal channels (`w1…`), each independently in its own state;
   droplets ride them. Lanes converge into two adjacent checkpoints in the
   same node style — **CI** and **REVIEW** — which render as *one calm
   waiting area* (no per-gate progress, §10). The **fix loop is drawn as
   the engine's true shape**: a return arrow from the checkpoint area back
   *into the lane itself*, labeled with the send-back reason (**review
   findings / checks failed / merge conflict**, from `drive-fixup.reason` /
   the fix-leg prescription), the lane chip showing `FIXING · round n of
   cap` (`workers.fix_rounds` vs `lanes.prFixCap`). From the connector
   between CI and REVIEW, the **escalation branch** — same stroke as a
   lane, rust — drops downward to a person node labeled **NEEDS HUMAN**;
   escalated PR droplets park on it. Rust appears nowhere else on the
   stage.
4. **Rings + reflection**: the trunk cross-section — strictly one ring per
   merge, no decorative base grain. At zero merges the disc area shows a
   small sapling glyph (`lucide-react`'s `Sprout`, §2 adjudication table)
   instead, with no numeral; once ≥ 1 ring exists, the disc fills with fine
   concentric rings (no border circle) and the big serif ring count sits at
   its centre, growing to the disc's own mockup-scale footprint as merges
   accrue (`stage.tsx`'s `TRUNK`/`ringRadii` growth rule). Then two small
   nodes **SUMMARY** (`harvesting`) and **RETRO** (`retro`), and the round's
   outcome tally (`N merged · N pending · N needs human`) — small numbers,
   never repeating the all-time ring count.

**LLM-backed** stage nodes (the planning trio, lanes, SUMMARY, RETRO) carry
their configured model·effort caption (§3 C); REVIEW shows the review *mode*
word instead (e.g. `codex`), flipped by `reviewer-fallback-*` events; CI and
the merge arm are not model-backed and carry no caption. Lane channels keep
the plain primary label "Work lane N" with the mono id demoted to small
print (§7).

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
read-only side drawer for that phase — the stage's paper trail, not just
its light. Contents are **strictly what existing sources hold** — the
explicit per-phase mapping (no field here may exceed the `events` /
`round_artifacts` contracts):

| Node | Drawer contents (source) |
|---|---|
| Goal & align | `align-summary` slice: created issues (with titles) + triaged issues (`align` in the artifact / the event, verbatim) |
| Arch review / Verify | that phase's `degradedPhases` entries, `plan-review-escalated` / `verify-na-proposed` counts from events |
| Lanes / CI / Review / merge | the round's `dispatches`, `merges`, `retries`, `escalations`, `handoffs` counters (artifact fields) |
| Summary | the artifact's own top-line numbers (spend vs round budget, throughput counters) |
| Retro | the `retro` outcome object (opened PR / degraded / neither) |

Every row also shows the node's configured model·effort (or gate ②'s review
mode). GitHub links are **derived from issue/PR numbers only** — no comment
anchors are persisted, so links go to the issue/PR, never a specific
comment. The "view log" entry displays the run's log-file **path**
(`logPath` in `/api/loop/state`, live-only — the server serves no log
content). Binding follows §11 mode purity: in live mode the drawer binds to
the open round (falling back per phase to the most recent **closed** round's
slice, labeled with its round id — never presented as current); in replay it
binds to the scrubbed round at the cursor, never a mix. Cross-round
*browsing* stays deferred (§10) — the inspector is one drawer about one
phase, not a history UI.

An issue is a **sap droplet** (amber dot with the issue number). Real events
drive it, via one anime.js timeline per transition:

| Event(s) | Animation |
|---|---|
| `dispatched` | Droplet detaches from the backlog stack, travels into a lane channel (`--travel`); the lane card (§3 C) lights `--sap` in the same beat. |
| lane `running → driving` (canonical source: the PR-open transition event, `reclaim-done` with `payload.next: driving` — `/state` polling is only the live overlay that may show it a beat earlier) | Droplet emerges from the lane carrying a PR tag and parks **at the CI / REVIEW checkpoint pair**, which breathes softly while the PR waits. The engine computes gate progress live against GitHub and persists no substate, so v0.2 renders the review passage as one *waiting* state — the checkpoints never fake per-gate progress or pass/fail states. (A persisted `gate-advanced` event unlocking the two-step animation is deferred, §10.) |
| `drive-fixup` → `fix-leg-started` | The droplet travels the **return arrow** back into its own lane; the send-back reason word (review findings / checks failed / merge conflict) lights on the arrow, the lane chip flips to `FIXING · round n of cap`, and the lane channel re-lights `--sap` — the worker fixing its own PR is the loop's proof moment. `fix-leg-resumed` re-lights the same state after a mid-fix handoff. |
| `fix-rounds-capped`, `fix-leg-verdict-rerun`, `drive-needs-human` | The droplet crosses onto the **rust escalation branch** and parks at the NEEDS HUMAN node; the same item lands as a row in the Needs-attention strip. Still, not loud. |
| `merged` | Both gates flash `--moss` with a ✓, the droplet crosses the merge arm into the trunk and **becomes a ring**: a new circle strokes in over 1.2 s, ring counter increments in Fraunces. The one celebratory moment. |
| `handoff` | Droplet folds back into the backlog with a small progress badge ("saved for a successor"). |
| `reclaim-failed`, `reclaim-dead`, `rollback-escalated` | Droplet stops, flips `--rust` with a static ✕; no shaking, no bouncing — failures are still, not loud. (`drive-needs-human` routes via the escalation branch above.) |
| `ceiling-escalated` / PAUSE / kill switch | Stage dims; ambient sap flow stops; header state word explains. |

Owner ruling Q6, 2026-08-17 (#729 design review; implemented by #920): dimming applies only to
a LIVE OPEN round under a safety tier or ceiling breach — replay and `?demo` never dim,
regardless of engine state (`isStageDimmed`'s `isLiveOpenRound` param, `hero/state.ts`).

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
fixture mode**: the run ships as one bundled JSON fixture carrying all
three replayable sources — `events`, `spend_ledger` rows, and the `rounds`
chapter rows (cursors + artifacts) — and `?demo` feeds it through the same
replay adapters, so replay cost and the phase inspector work in the demo
exactly as in replay. An events-only fixture could not (§11 folds
`events + spend_ledger`; the inspector reads artifacts). No new dependency;
the replay reducer is the mechanism either way.

## 7. Copy — the plain-language layer

All user-visible sentences live in one module (`copy.ts`), keyed by event
kind. Voice: active, specific, no system internals (say "lane", "CI",
"review", never "reclaim", "tick", "worktree").

**Terminology rule** (clarified 2026-07-21): "no jargon" bans
**project-internal** vocabulary — gate⓪/①/② numbering, harvest, reclaim,
PO — never industry-standard words. Standard terms are the *first choice*
precisely because they convey what actually happens: **CI**, **retro**,
**backlog**, **emergency stop**. A label must let an outsider infer the actual work
performed at that node. The kinds — counted by the
map, never by this prose: an earlier hard-coded "33" here had already
drifted past #180's park/environment family, proving §2's own rule
(`run-started`/`round-phase` shipped with #206; **every
engine PR that adds an event kind must extend this map; make it a gate②
checklist item**):

| Event kind | Feed sentence |
|---|---|
| `dispatched` | Started work on issue #{issue} |
| `dispatch-failed` | Couldn't start issue #{issue} — it's back in the backlog |
| `reclaim-done` | Branches on `payload.next`: PR produced → "Lane {worker} opened a PR — now in review"; ended without a PR → "Lane {worker} ended without a PR — {reason, or "reason not recorded" — #881 payload gap, see below} · asks: review the lane's outcome and decide whether to retry". #890: either branch appends " · est $X → real $Y" when the payload carries `estCostUsd` (the lane's last live estimate) AND `costUsd` is known-real (`costEstimated === false`) — omitted whenever `estCostUsd` is absent or `costUsd`'s provenance is itself an estimate or unknown, never a fabricated "real". |
| `reclaim-failed` | Lane {worker} hit a problem and stopped — {reason, or "reason not recorded"} · asks: investigate and decide whether to retry |
| `reclaim-dead` | Lane {worker} went silent — cleaned up; its issue goes back to the backlog |
| `handoff` | Lane {worker} reached its budget and saved its progress for a successor |
| `merged` | Merged PR #{pr} — checks green and review approved |
| `drive-needs-human` | PR #{pr} needs a human decision — {reason word, narrow-pattern-matched off `payload.reason`'s machine gate code, falling back to the raw code or "reason not recorded"} · asks: decide the PR's next step |
| `drive-no-pr` | Lane {worker} ended without opening a PR — reason not recorded · asks: check the lane's log and decide next steps (#881 payload gap: no reason field exists upstream today) |
| `drive-queued` | PR #{pr} is ready — waiting its turn to merge |
| `drive-stopped` | PR #{pr} is open and left for you — auto-merge is off |
| `pool-selected` | Selected {n} issue(s) for this round |
| `drive-fixup` | PR #{pr} sent back to fix — {reason} (reason word from the payload: review findings / checks failed / merge conflict) |
| `fix-leg-started` | Lane {worker} is fixing its PR — round {n} of {cap} |
| `fix-leg-resumed` | Lane {worker} resumed fixing after a handoff |
| `fix-rounds-capped` | PR #{pr} used up its fix attempts ({fixRounds}/{cap}, when the payload carries them) · asks: adjudicate — re-ready or close manually |
| `fix-leg-verdict-rerun` | PR #{pr}'s review findings aren't fixable by the producer · asks: adjudicate |
| `ceiling-escalated` | Safety ceiling reached ({reasons.join}, when carried) — winding down all work · asks: resume when it clears, or raise the ceiling |
| `ceiling-breach-entered` | Branches on `payload.reason` (#431 round 3: one event per REASON, each ceiling has its own lifecycle): wall-clock → "This run hit its {maxWallClockSec}s attention alarm — no new work until a restart"; daily-budget → "Today's ${dailyBudgetUsd} budget is spent — no new work until tomorrow". One per reason per episode, never per tick |
| `rapid-restart-detected` | Engine started {births} times in {windowSec}s — crash loop suspected, dispatch parked for a human · asks: clear the park once resolved (#431; #893: promoted to an attention-strip item, see the `idle-churn-detected` row below for why) |
| `ceiling-breach-cleared` | Branches on `payload.reason` (#431 round 3): wall-clock → "The wall-clock alarm cleared"; daily-budget → "The daily budget rolled over" — that reason's closing receipt; work resumes only when no ceiling remains open. One per reason per episode, transition-only |
| `rollback-recovered` | Returned issue #{issue} to the backlog safely |
| `rollback-retry-failed` | Still trying to return issue #{issue} to the backlog |
| `rollback-escalated` | Couldn't return issue #{issue} automatically ({reason}, when carried) · asks: return it to the backlog by hand |
| `engine-review-verdict` | Branches on `payload.outcome` (#489): approved → "Review approved PR #{pr} — {findingCount} finding(s) noted"; rejected → "Review sent PR #{pr} back — {findingCount} finding(s) to fix". The engine's own reviewer reaching a decision, emitted once per review run (`runId`); the sentence stops there — what happens next is narrated by `merged` / `drive-fixup` themselves. A SUMMARY: counts only, since the findings themselves live in the PR's audit comment. `findingCount`/`perAC` are `null` when the run's artifact wasn't observed — say "counts unavailable", never "0" |
| `engine-review-budget-advisory` | This review’s ${capUsd} budget is a guide, not a limit — the tool running it can’t enforce one (#443). Emitted once per review attempt, before it starts, only for the local Codex reviewer (`reviewer.agent.runner: codex-exec`); the Claude reviewer enforces its budget for real and stays silent here |
| `engine-review-cost-unknown` | This review finished without reporting what it cost — its spend is unknown, not zero (#443). Never shown as “$0” anywhere; the attempt is treated as unmeasured, which is also why it is never retried on a leftover budget |
| `engine-review-containment-gap` | Recorded limits, not an incident: this review ran in a sandbox that blocks writes but still lets the reviewed code run, and does not limit which files it can read — including files outside the reviewed code (#443, one line per entry in `payload.gaps`). Emitted at every local-Codex review start so the limits are on the record rather than assumed away — not an attention item, and never a reason on its own to stop a lane; the place that explains what it means for a reader is the security guide, which this sentence should link |
| `engine-review-orphaned-group` | A review that ran out of time was stopped, but something it started is still running on this machine (#443, `payload.pid`). The review itself is settled and reported as timed out — this is a separate heads-up that a leftover process may still be doing work, and is worth a look by a person |
| `engine-review-session-inspection` | How many tool/command calls this review session made while looking things over (#512, `payload.toolItemCount`), only for the local Codex reviewer. A record, not a verdict: nothing in the engine reads this to decide the review's outcome — treat a low count as a prompt for a human to skim the transcript, never as a reason to distrust or rerun the review on its own |
| `reviewer-fallback-switch` | The usual reviewer isn't answering — switched to the backup |
| `reviewer-fallback-revert` | The usual reviewer is back — switched back |
| `pr-held` | A person put PR #{pr} on hold — nothing moves until they lift it |
| `pr-released` | Hold released — PR #{pr} resumes |
| `lane-state-labeled` | Lane {worker} is now shown as working on PR #{pr} (#399). Bookkeeping, not an attention item: it records that the engine put its lane-state label on the PR so the PR list says someone is on it. One per lane per PR, never per tick |
| `lane-state-cleared` | PR #{pr} no longer shows lane {worker} as working on it (#399) — the lane ended (merged, escalated or dead), or the label write failed and will be retried. Same bookkeeping tier as its twin above |
| `resume-held` | Lane {worker}'s handoff can't resume — issue #{issue} still carries `{label}`. Deliberately **not** an attention item (§3): it is the *consequence* of a hold, not a new thing waiting on a person — whoever owns that label already has the strip row (an engine escalation) or applied it themselves (a human). Its job is to make an idle lane legible; one per suppression episode, never per tick (#441) |
| `worktree-retained` | Kept lane {worker}'s working folder for inspection (at `{worktreePath}`, when carried) — reason not recorded · asks: inspect and clear when done (#881 payload gap: no reason field exists upstream today) |
| `worktree-released` | Lane {worker}'s retained folder was cleaned up |
| `env-failure` | Lane {worker} hit an environment problem — not the work itself (subsequent events narrate the disposition; this sentence claims none of it — `hasPr` alone cannot pick the outcome) |
| `env-failure-preserved` | Kept lane {worker}'s work safe after an environment problem ({source}, when carried) — its PR needs a human to continue it · asks: inspect the environment and continue the PR |
| `park-escalated` | The environment keeps failing ({source}, when carried) — paused dispatch · asks: clear the park once resolved |
| `park-probe` | Branches on `payload.success` and `payload.source`, stating **only the check's own result** — never a global outcome (a mixed forge+LLM park can pass one check and stay parked): forge + passed → "Forge check passed"; llm + passed → "Model check passed"; failed → "Environment check failed — still waiting". What happens next is narrated by `park-resumed` / `park-canary` themselves |
| `park-resumed` | Environment recovered — resuming work |
| `park-canary` | Sent one test lane to check the environment |
| `park-canary-failed` | The test lane failed — still waiting on the environment |
| `park-canary-inconclusive` | The test lane didn't settle it — still waiting on the environment |
| `tick-error` | The engine hit an error this cycle — it will retry |
| `standby-wait` | Nothing to work on — checking again in {waitSec} s |
| `standby-exit` | Work appeared — resuming after {attempts} quiet check(s) |
| `round-stop` | This round reached its limit ({detail}) — no new work this round |
| `align-summary` | Planning pass: {n} issue(s) created, {m} plan(s) drafted |
| `triage-degraded` | A planning session had trouble — some issues keep their old plans |
| `plan-review-escalated` | Issue #{issue}'s plan needs a human — {payload.reason, falling back to "automated review couldn't approve it"} · asks: revise the plan or adjudicate |
| `verify-na-proposed` | Issue #{issue} proposed as not separately verifiable — reason not recorded · asks: approve or reject the proposal (#881 payload gap: no reason field exists upstream today) |
| `gated-reentry` | Issue #{issue}'s PR was unblocked by a human — back through review |
| `lane-revived` | Issue #{issue}'s PR picked back up after an environment failure — back under review |
| `gated-reentry-capped` | Issue #{issue} was unblocked {attempts, or "too many"} times without landing · asks: merge by hand — automatic reentry exhausted |
| `gated-reentry-capped-label-failed` | Couldn't re-flag issue #{issue} ({error}, when carried) · asks: check it manually (retries automatically — not urgent) |
| `escalation-resolved` | Branches on `payload.via`: merged → "Issue #{issue} no longer needs you — PR #{pr} was merged"; issue-closed → "Issue #{issue} no longer needs you — it was closed"; pr-closed → "Issue #{issue} no longer needs you — PR #{pr} was closed without merging"; label-removed → "Issue #{issue} no longer needs you — the flag was cleared"; board-fixed → "Issue #{issue} no longer needs you — the board was set to Done". Never an attention item — this is the event that *clears* one (§3) |
| `needs-human-swept` | Issue #{issue} no longer carries `{label}` — the engine removed the flag it had applied itself, now that its escalation is resolved. Never an attention item; it is the receipt that a cleared item's *carrier* was cleared too. Only ever follows a `merged` or `issue-closed` resolution; a PR closed without merging still owes a human decision and keeps its flag (#441) |
| `retro-pr-opened` | The loop proposed an improvement to itself — PR #{pr} awaits review |
| `retro-pr-degraded` | A self-improvement proposal didn't come together this round |
| `run-started` | Engine started a new run |
| `instance-lock-taken-over` | Took over the engine lock left by a crashed run (pid {previousPid}) |
| `round-phase` | Round {round_id} moved into {phase}. The terminal `closed` entry additionally carries the idle-churn breaker's own per-round sample (#470): `idle` (this round dispatched nothing and left no lane in flight) and, for an idle round only, `fp` — a digest of every durable fact the round appended. Both are diagnostics for that breaker's ledger-derived streak, not feed copy; the sentence is unchanged |
| `idle-churn-detected` | The loop ran {rounds} rounds in a row that changed nothing at all — parked for a human · asks: clear the park once resolved (#470). **#893 (owner adjudication 2026-08-14) supersedes the prior "not an attention-strip item" ruling here**: `idle-churn-detected`, `rapid-restart-detected`, `consecutive-stalls-detected`, and `empty-spin-park` are now attention-strip items (`BREAKER` chip) — none carries an issue/PR, so the strip row has no entity link, but the whole point of the strip is "something is waiting on a person," and a probe-less park episode with no automatic clear unambiguously is. |
| `ci-inert-escalated` | PR #{pr} needs a human — CI concluded without ever going green ({check names, when the payload's `checks` items are strings, else a bare count}) · asks: fix the check, then clear the label to retry (#783). An attention item — it carries a `needsHuman` label the moment it fires |
| `ci-pending-observed` | PR #{pr} is waiting on CI. Opens the CI-pending pin `ci-pending-escalated`'s escalation timer reads; routine, not an attention item |
| `ci-pending-escalated` | PR #{pr} needs a human — CI stayed pending too long to progress on its own (gate② was already decisive), naming `blockedChecks`/`checks` when carried · asks: re-run or fix the stuck check, then clear the label. An attention item — it carries a `needsHuman` label the moment it fires |
| `ci-pending-cleared` | PR #{pr}'s CI resolved. Closes the pin `ci-pending-observed` opened, canceling the escalation timer; routine, not an attention item |
| `emergency-stop` | EMERGENCY STOP triggered — every running lane was killed immediately, no drain window · asks: inspect in-flight work for lost progress before resuming (#893: was deliberately absent as "a control signal, not a feed event kind" — but the engine registers it `actionability: intervene` and does append it durably, #293, so it needed a real row like every other registered kind) |
| `consecutive-stalls-detected` | The engine stalled {streak}/{maxConsecutiveStalls} times in a row — dispatch parked for a human · asks: clear the park once resolved (#893; #407) |
| `empty-spin-park` | The peripheral roles kept failing to produce work — paused dispatch · asks: clear the park once resolved (#893; #374) |
| `base-ci-red-escalated` | The default branch's CI is red ({failing.join}, when carried) — no PR can merge until it's fixed · asks: fix the default branch's CI (#893; #502) |
| `estop-lane-swept` | Lane {worker}'s driving work was killed by EMERGENCY STOP ("— the process couldn't be confirmed dead", when `confirmedDead` is `false`) · asks: check for an orphan process and confirm the PR's state (#893) |
| `estop-lane-sweep-incapable` | Lane {worker}'s EMERGENCY STOP sweep couldn't verify or signal its process — left unsettled · asks: check the lane by hand (#893) |
| `resume-capped` | Lane {worker} exhausted its resume attempts ({attempts}, when carried) after a handoff · asks: resume or reassign the lane by hand (#893; #172) |
| `resume-undecidable` | Lane {worker}'s resume outcome couldn't be determined from the ledger · asks: check the lane by hand and decide whether to resume (#893; #172) |
| `orphan-pr-escalated` | PR #{pr} is open but lane {worker} is dead ({via}, when carried) · asks: check the PR and decide whether to retry the issue (#893) |
| `gated-flag-unprovable` | Lane {worker}'s reentry flag couldn't be found on either carrier · asks: check issue #{issue}'s labels by hand (#893; #391) |
| `drive-human-merge-only` | PR #{pr} is ready but requires a human to merge it — a one-way, never re-decided policy · asks: review and merge by hand (#893; #292/#397) |
| `fix-leg-dispatch-unconfigured` | PR #{pr} needs a fix leg but the fix loop isn't configured for this run · asks: enable the fix loop or fix the PR by hand (#893) |
| `fix-leg-undecidable` | PR #{pr}'s fix leg outcome couldn't be determined from the ledger · asks: check the lane and decide the PR's next step (#893) |
| `fix-thread-write-escalated` | PR #{pr} has a review-thread reply/resolve that couldn't be posted after retrying · asks: check the review thread by hand (#893; #398) |
| `ac-snapshot-drift` | PR #{pr}'s issue body changed after its acceptance criteria were captured · asks: confirm the PR still matches the issue, or re-snapshot (#893; #279) |
| `review-silence-escalated` | PR #{pr}'s review request went unanswered ({silenceSec} rounded to minutes, when carried) · asks: check the reviewer and prompt or reassign the review (#893; #170) |
| `review-disputed` | PR #{pr} — successive reviews disagreed past the dispute limit · asks: adjudicate which review is right (#893; #451) |
| `review-non-convergent` | PR #{pr} — fix-and-review rounds failed to converge · asks: adjudicate — re-ready or close manually (#893; #450) |
| `comment-cursor-stale` | Issue #{issue}'s comment thread moved since the engine last read it, so it refused to spend/dispatch/drive · asks: review the comment thread — this clears once the engine re-reads it (#893; #652) |
| `round-pool-removal-capped` | Issue #{issue}'s round-pool label couldn't be removed after retrying · asks: remove the label by hand (#893) |
| `concern-post-escalated` | Issue #{issue}'s PO concern couldn't be posted after retrying · asks: check the issue and post the concern by hand (#893; #237) |
| `operator-fence-violated` | Issue #{issue}'s body edit was refused — it touched an operator-owned section · asks: review the proposed edit and the operator fence by hand (#893; #827) |
| `architect-repeat-drop-escalated` | Issue #{issue} was dropped repeatedly for the same reason with no edit in between · asks: revise the issue or adjudicate the repeated drop (#893; #666) |

**#893 — the telemetry tier.** The table above is the NARRATIVE half of the dashboard's
`EventKind` union (`copy.ts`'s `COPY` map) — `EventKind` itself is a compile-time type import
from the engine's own event-kind registry (`engine/src/state/event-kinds/index.ts`, #425), not a
hand-maintained union. The remaining ~100 registered kinds (heartbeats: `worker-heartbeat`,
`role-session-heartbeat`, `park-wait-heartbeat`, `standby-heartbeat`; and bookkeeping: reconcile
rollups, label-write receipts, degrade-and-retry telemetry, …) have no narrative worth telling on
their own — `copy.ts`'s `TELEMETRY_KINDS` set classifies each of them instead, rendering an
honest generic line (`Telemetry: <kind>`, never the raw wire kind unexplained) that the live
feed collapses from its default view (opt-in "show" toggle) rather than ever falling through to
the "Unrecognized event" fallback. Every kind the engine registers lands in EITHER this table
(via `COPY`) OR `TELEMETRY_KINDS` — never neither, never both — enforced by copy.test.ts's
cross-package exhaustiveness test (see the verification-contract paragraph below).

The same module captions lane states (`running` → "writing", `driving` → "PR
under review", `handoff` → "handed off") and config keys (§3 E). Kinds whose event leaves
work waiting on a person additionally carry `attention` on the same entry —
`true`, or a payload predicate where only some payloads qualify (§3) — so
the strip and the sentences share one map and cannot drift apart.

**Verification contract — the cross-package anchor** (#893, 2026-08-14, superseding the
2026-08-07 retro round #344 wording below): the earlier form of this contract — "adding an event
kind without a copy entry is a type error" — was anchored ONLY inside the dashboard package: it
proved a dashboard-local `EventKind` union stayed in sync with `COPY`, but had no link at all to
the engine's own registry (`engine/src/state/event-kinds/index.ts`, #425), and a premise-check
found it had silently failed ~126 times (126 of 194 then-registered engine kinds had no `COPY`
entry — the gap this PR closes). The contract now has a real cross-package anchor:

1. **The type anchor.** `dashboard/src/copy.ts`'s `EventKind` is `import type { EventKind } from
   "../../engine/src/state/event-kinds/index.ts"` — erased at build (`import type`), so the
   browser bundle carries zero engine runtime code, but the union itself is the engine's, not a
   second one kept in sync by hand or convention.
2. **The classification anchor.** Because `COPY` no longer needs to be exhaustive over every
   engine kind (the telemetry tier above covers the rest), "an engine kind with no copy entry" is
   no longer a *pure* type error — it is a **build/test failure**: copy.test.ts's cross-package
   exhaustiveness test imports the engine's `EVENT_KIND_NAMES` (test-only, same precedent as
   `ESCALATION_SOURCE_KINDS`) and asserts every one is classified as EITHER a `COPY` key OR a
   `TELEMETRY_KINDS` member, never neither, never both. Mutation-kill proof: remove any one
   mapping from either set in `copy.ts` and that kind's test loop iteration reddens.
3. **The sentence-text anchor**, unchanged from the 2026-08-07 wording: a test that only counts
   one `COPY` entry per table row does not verify against this row's literal documented sentence
   — a table-driven oracle asserts each kind's rendered output against the string in this table
   (including its branches), so a sentence and its doc row can't drift apart either.

`LoopEvent["kind"]` (and any events-fixture type used in tests) must still be `keyof typeof COPY`,
`EventKind`, or a type imported from one of them, not a second union kept in sync by hand — a
runtime fallback branch (e.g. `copyFor` returning `undefined` for a genuinely unknown kind) is a
legitimate defensive measure but is not evidence for this claim and must not be cited as
satisfying it.

**Stage labels lead with plain language** (decided at the design-director
review: PO / gate⓪ / harvest are jargon to anyone who hasn't read PLAN.md,
and the small-print caption "PO · goal alignment" is still jargon; *retro*
is reprieved by the terminology rule above — it is standard agile
vocabulary).
On the stage the plain word is the **primary** label and the internal term
the secondary small print — not the other way around:

| Stage (internal) | Primary label | Hover explainer (one sentence, from `copy.ts`) |
|---|---|---|
| PO / aligning | Goal & align | Decides what's worth doing this round and files it as issues |
| Architect | Arch review | Checks the round's plans fit the architecture before work starts |
| gate⓪ plan review | Verify | An independent review approves each plan — including how it will be verified — before any code is written |
| Lanes / workers | Writing | Autonomous workers implement approved issues, one lane each |
| lane channel `wN` | Work lane {N} | One autonomous worker's slot — reused across issues |
| `fixing` state | Fixing (round {n} of {cap}) | The worker is addressing review findings on its own PR |
| gate① checks | CI | Automated checks must pass before a PR moves on |
| gate② review | Review | An independent reviewer approves the PR against its plan |
| escalation exit | Needs human | Work that automation can't finish waits here for you |
| Merge / rings | Merged | Approved work lands; every merged PR adds one ring |
| Harvest | Summary | Collects what the round produced and what needs a human |
| Retro | Retro | The loop proposes one improvement to itself |
| zone captions | Plan / Implement / Outcome | The three phases spanning the hero; role words (producer ≠ reviewer ≠ merger) live in the "?" legend, not on the stage |

These labels and explainers live in the same `copy.ts` module — one map, no
second vocabulary. A small **"?" legend toggle** in the header overlays the
three metaphor keys in one line each: droplet = an issue moving through the
loop; lane = one autonomous worker; ring = one merged PR. That is the whole
onboarding surface — no tour, no modal sequence.

### Time display

Decided 2026-08-03 (owner + peer architecture review, #587) — this document had no rule
for rendering absolute times, and unlabeled absolute times are actively misleading once
the dashboard is viewed from a different timezone than the operator machine. A full
timezone picker is explicitly out of scope (marginal-complexity principle): these are
display rules only — §11's stored/replayed ISO timestamps and durations/elapsed values
(lane-card elapsed, §3 C) are untouched.

1. **All absolute times render in the viewer's browser-local timezone**, via the `Intl`
   API — zero config, zero dependency.
2. **Every relative timestamp gets hover-absolute detail.** Feed timestamps ("14s ago",
   §3 D) and needs-attention age chips (§3, "Needs attention strip") keep their existing
   relative form on the surface; the absolute time is always one hover away.
3. **Absolute times always carry the UTC-offset label** (e.g. `14:32 +09:00`) — a bare
   wall-clock time is never shown on its own; it is ambiguous the moment viewer and
   operator sit in different zones.
4. **One toggle: local / UTC** — for correlating with operator-machine logs. Explicitly
   not a timezone picker. Display-only state: component state, optionally mirrored to
   `localStorage` so a reload keeps it — no server round-trip, no per-user persistence
   contract.

**One helper, one path.** `dashboard/src/format-time.ts` is the only place that calls
`Intl.DateTimeFormat`/`toLocaleString` on a stored ISO timestamp: `formatAbsoluteTime(iso,
mode)` renders rules 1 + 3 for a given `TimeMode` (`"local" | "utc"`); `formatRelativeWithAbsoluteTitle`
pairs the relative string with its `formatAbsoluteTime` hover title so rule 2's
relative→hover-absolute path can't drift out of sync. An inline `toLocaleString` call
anywhere else in `dashboard/src/**` is a review finding — gate② checklist item, same
pattern as §7's copy-map-extension rule above.

## 8. Data contract

Four read-only GET endpoints plus the single `POST /api/control` route
(below), served from the existing SQLite tables
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
                                    // engine's stale-gap threshold → stalled UNLESS a standby
                                    // signal is fresh (see below); no open round + newest
                                    // standby-wait/standby-heartbeat newer than any standby-exit
                                    // AND within its own declared window (waitSec/remainingSec)
                                    // → standby (parked, healthy — #125, #723); else running.
                                    // #723 (AC12 operator probe): a standby backoff dwell
                                    // deliberately stops the tick heartbeat for up to
                                    // round.standby.backoffCapSec (default 1800s) — well past
                                    // the stale-gap's 900s floor — so the standby-freshness
                                    // check runs BEFORE staleness decides and overrides it; a
                                    // standby signal that has itself gone stale beyond its own
                                    // window is NOT fresh, and a stale tick with no fresh
                                    // standby signal still renders stalled, unchanged. #746: a
                                    // run-ended/engine-stalled terminal STRICTLY NEWER (by event
                                    // id) than the standby signal ALSO invalidates its freshness
                                    // — a process that exits mid-standby-dwell never appends
                                    // standby-exit (round.ts's exit-append site is reached only
                                    // on a normal resume, never on process death), so without
                                    // this check a dead engine would keep rendering `standby`
                                    // until the lingering signal's own window happened to elapse.
                                    // Precedence (fixed 2026-07-21, resolving §8 vs
                                    // walkthrough §6): STALENESS BEATS PAUSE — a dead engine
                                    // with a PAUSE file renders stalled, the sentinel demoted
                                    // to a secondary chip ("PAUSE set"); KILL_SWITCH + stale
                                    // stays stopped (truthful either way). Derivation is
                                    // server-side only, so `sapwood status` and the dashboard
                                    // can never disagree (`sapwood status`'s text does not
                                    // itself render this word today, #723 audit — see the
                                    // engine-state derivation module's own doc). Env-park folds
                                    // into the standby display tier ("waiting") with a park
                                    // sub-caption — no eighth state word.
    "reasons": [],                  // ceiling_breach.reasons when winding-down
    "lastTickAt": "2026-07-09T08:12:00Z",  // engine_session.last_tick_at
    "standbyNextCheckSec": 42       // #723: seconds until the next standby probe — the standby
                                    // signal's own declared window minus its age, floored at 0.
                                    // null unless state === "standby" (never a stale countdown
                                    // left over from a prior dwell). The header caption folds
                                    // this into "idle — nothing to work on right now — checking
                                    // again in 42s" (§7's copy convention applied to the engine
                                    // word, dashboard/src/copy.ts's engineStateCaption).
  },
  "lanes": {
    "max": 3,                       // config lanes.max (null if config unreadable)
    "items": [{                     // workers rows, running + driving
      "lane": "w1", "issue": 86,    // numbers link out to GitHub; titles come from the
                                    // entity's title-bearing events (#207, §3 C), not from here
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
  "logPath": "data/logs/run-….log", // the run-scoped engine log file's path (#193) — shown by
                                    // the phase inspector's "view log" entry (§6); live-only,
                                    // path only — the server never serves log content
  "config": { /* ALLOWLISTED subset of resolved config (§3 E) — the server names the
                 keys it serves, never the whole object; includes the per-role
                 model/effort keys the §3 C/§6 captions read */ }
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
served verbatim (`id, ts, worker, issue, usd, model`, token counts, and —
since #645 — `actorKind`/`role`/`estimated`, the durable attribution
columns; `null` on a row that never claimed one, same never-guess stance
as everywhere else this triple appears); the replay cursor maps event →
spend position by timestamp (`spend_ledger.ts <= current event's ts`) —
display-grade alignment, no cross-table join.

**Phase bucketing** (the §3 E "by phase" bars): a spend row belongs to the
phase whose `round-phase` window (#206's full trail — initial `aligning`,
every transition, terminal `closed`) contains its `ts`; same
display-grade timestamp rule as the cursor mapping. Rows outside any known
phase window — all pre-#206 history — bucket as **"unattributed"**, drawn
last and labeled; a silent misfile into a real phase is worse than an
honest leftover bucket.

**`GET /api/rounds`** — replay chapter marks and the round navigator's list
(§3 A). Re-anchored 2026-07-21: the **`rounds` table is the spine** — one
row per round, open or closed, including rounds that closed without an
artifact (pre-#123 history, or a crash between `closeRound` and
`saveRoundArtifact`) — with the artifact **left-joined** for the outcome
tally (merged PRs, spend, escalations); rows without an artifact render
tally-less, honestly. Each row also carries `status`, `startedAt`/`endedAt`,
and an `eventCount` for the transport's "event n/N". Ascending:

```jsonc
{ "rounds": [{ "roundId": 12, "schemaVersion": 1,
               "startEventId": 480, "startSpendId": 3111,
                                 // the #123 id cursors from the `rounds` row —
                                 // replay's exact chapter windows (§11); they are
                                 // NOT artifact fields, the server joins them in
               "artifact": { /* the validated JSON, verbatim —
                                docs/round-artifact.md is the contract; the UI
                                checks schemaVersion and says "newer schema —
                                update the dashboard" rather than mis-render */ } }] }
```

Server: `node:http` on `127.0.0.1` (port configurable, default 4517), SQLite
opened read-only, serves `dashboard/dist` statics plus these four GET
routes and exactly one write route:

**`POST /api/control`** — body `{ "verb": "start" | "pause" | "resume" |
"stop" | "estop" }`, allowlist-validated; anything else is 400. Effect is
sentinel-file creation/removal only (§3 Operations) — the SQLite handle stays
read-only, no config or GitHub writes exist. Requests must be same-origin JSON:
`Content-Type: application/json` plus the `X-Sapwood-Control` header (§3
Operations); the server grants no CORS, so a foreign page cannot preflight
through. Response is the §8 engine state after the signal — for Stop that
is `{"state": "stopping"}` (KILL_SWITCH + active lanes, per the derivation
above), so the UI renders the real transition, never an optimistic flip.
When `dashboard.controls: false`, the route is not registered (404) and the
buttons don't render — the pure-spectator posture remains available as
configuration.

## 9. Tech architecture

```
dashboard/            # npm workspace — listed in root package.json "workspaces"
                      # alongside "engine" (#143). Omitting it makes root -ws
                      # build/test/typecheck silently skip the package while CI reports green
  index.html  vite.config.ts
  server.ts           # node:http + node:sqlite, ~150 LOC, no deps
  src/
    api/              # fetch + TanStack Query hooks (poll 3 s)  ── the data layer
    replay/           # event-folding reducer + player hook      ── shared with live
    hero/             # SVG stage + anime.js timelines
    components/       # Header, NeedsAttention, LaneBoard, Feed, CostStrip,
                      # ConfigDrawer, Controls (the §3 verbs + confirm flow)
    copy.ts           # §7 — the single copy map
    format-time.ts    # §7 "Time display" — the only Intl/toLocaleString call site
    fonts/            # the one bundled display face (Fraunces, latin subset woff2)
    contrast.ts       # §5 quality-floor checker — test assertion + `npm run contrast`
    tokens.css  app.css
```

CI (`.github/workflows/ci.yml`) invokes checks per workspace
(`npm --workspace engine …`) rather than via `-ws`, so adding the workspace alone
does **not** put the dashboard in CI — the workflow needs matching
`--workspace dashboard` steps. That file is human-merge-only (security.md), so it
lands as a separate human-authored change.

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

### Server — what has landed (#142, completed by #360)

`dashboard/server.ts` serves the whole §8 surface: the four READ routes (`GET
/api/loop/state`, `GET /api/events?after=&limit=`, `GET
/api/spend?after=&limit=`, `GET /api/rounds`), the single gated `POST
/api/control`, and the `dashboard/dist` statics.
`createDashboardServer({ dbPath, configPath, port, staticDir })` opens `State`
in `readOnly` mode, binds `127.0.0.1` (default port 4517), and dispatches
through a pathname→method route table. There is no CLI entry point yet — until
`sapwood dashboard` lands, the server is started from code.

Security posture (loopback-only, no auth boundary, raw event feed) is
documented in [`docs/security.md` "Dashboard: loopback bind, not an auth
boundary"](security.md#dashboard-loopback-bind-not-an-auth-boundary) — that
page, not this one, is the canonical statement of the boundary.

Wire details the frontend can rely on:

- Both paged feeds answer `{ <name>: [...], "lastId": n }` — `events` for
  `/api/events`, `spend` for `/api/spend` — with the same `after`/`limit`
  contract, a shared 1000-row page cap, and a `lastId` that an empty tail
  leaves at the caller's own cursor rather than rewinding to 0.
- `/api/rounds` is unpaged: one row per round is a chapter index, not a feed.
  Every `rounds` row appears, artifact-less ones included, with
  `schemaVersion`/`artifact` both `null` when there is no artifact (render
  tally-less, never skip the round). `eventCount` is the round's slice of the
  ledger — its own `startEventId` exclusive to the *next* round's inclusive, so
  the counts partition the ledger; events before the first round belong to none.
- Anything outside `/api/` is a static: a real file under `dashboard/dist`, else
  the `index.html` shell (the app is client-routed). `/api/*` never falls back —
  an unknown API path is an honest JSON 404. "Under `dist`" is checked against
  **real** paths on both sides (the root is realpath'd once at startup): a
  textual `../` is refused before the filesystem is touched, and a symlink
  anywhere under `dist` that resolves outside it is refused too, rather than
  followed or laundered into the shell fallback.

Five things about it are decisions, not implementation detail:

- **The write route is registered, not hidden.** `dashboard.controls` (#210)
  decides whether `/api/control` exists at all; `false` — *and an unreadable
  config*, fail-closed — means a 404, so the spectator posture is structural.
  The route defends itself server-side: `X-Sapwood-Control` (which forces a
  preflight this server never grants), an `application/json` content-type (so a
  no-preflight form POST cannot reach a verb), and an `Origin` that, when
  present, must be this server's. Its verb allowlist is exactly `start`,
  `pause`, `resume`, `stop`, `estop` — `estop` joined once #293's
  `EMERGENCY_STOP` sentinel landed (#724), because a verb that reports success
  while signalling nothing would have been worse than a 400. The only effect is
  creating/removing the engine's own `PAUSE`/`KILL_SWITCH`/`EMERGENCY_STOP`
  files, and the reply is the engine state read back *after* the signal (`stop`
  answers `stopping` while lanes drain; `estop`'s reply additionally carries a
  `message` naming the real consequence — immediate hard kill, WIP stranded
  pending human review, never an unqualified "lost"), so the UI renders the
  real transition.

- **The config surface is an allowlist**, `CONFIG_ALLOWLIST` in the same file —
  the §3 E groups' named leaves plus the per-role `model`/`effort` keys. A
  config key added later is not served unless someone adds it there, so the
  no-secrets guarantee survives config growth.
- **The engine-state derivation lives server-side only** and reads the engine's
  own `State`/config rather than re-querying SQLite, so `sapwood status` and the
  dashboard cannot drift apart — the control route's reply goes through that
  same derivation. Its six dashboard-only reads (`lastTickAt`, `countEvents`,
  `eventsPage`, `spendByModelForDay`, `spendPage`, `listRounds`) are read-only
  additions to `engine/src/state/state.ts` — notably `lastTickAt`, which reads
  the heartbeat without the write `touchLastTick` performs.
- **The SQLite handle stays read-only even now that a write route exists.** The
  control verbs write files, never rows; a write attempted through the handle
  still throws, and the test suite asserts it after a successful control call.
- **`spend.runUsd` is `null`** until follow-up #206's `run-started` event
  persists the #154 run anchor (today it exists only in engine-process memory).
  The header meter therefore falls back whole to the daily tier, exactly as §3 A
  already specifies — no new machinery, and no mixed-tier fraction.

The server is Node-side and the vite frontend is not, so the package carries two
tsconfigs — `tsconfig.json` (bundler resolution, DOM) for `src/`, and
`tsconfig.server.json` (NodeNext, no DOM) for `server.ts`; `npm run typecheck`
runs both. The CI gap noted above applies to it unchanged.

## 10. Deferred (v0.3+)

- **Config editing** — needs a config write path + auth story; contradicts
  v0.2's no-config-writes posture (the §3 control verbs are deliberately not
  a precedent: run-state signals, not config mutation).
- **Deep round-browse views** (per-round drill-down pages beyond the lit
  stage nodes, the replay chapters, and the single-phase inspector drawer
  (§6), which are IN for v0.2) — the `round_artifacts` data exists; the
  additional cross-round UI surface is not v0.2 scope.
- **History-aggregation metrics** (cycle time, merge/rework rate) — deferred
  by PLAN.md, gated on GitHub-history work.
- **WebSocket push** — polling at 3 s is indistinguishable for a local
  single-viewer tool; revisit only if a hosted multi-viewer mode ever exists.
- ~~Issue-title enrichment~~ — **un-deferred** by the design-director
  amendment: titles now ride event payloads written by the engine (§3 C,
  §11 follow-up #3); no GitHub read from the dashboard server was ever
  needed. Pre-amendment events lack tooltips — as does `merged`, whose own
  `prTitle` is still the human-merge-only residual noted at §11 #3.
- **Per-gate progress in the hero** — needs the engine to persist gate
  substate (a `gate-advanced` event); v0.2 renders the review passage as one
  waiting state (§6).
- **Scrubbing within the open round** — a "cursor behind HEAD" mode with
  its own rules for control visibility, est overlays, and auto-follow;
  deferred to v0.3 (§11). A round is fully replayable the moment it closes.
- **Honest "On hold" rendering** — blocked on the hold-visibility events
  (#294, §11 follow-up #7); until then held PRs render as waiting.
- **Config replay** — unblocked by #206 (`run-started` now carries the
  allowlisted snapshot, §11), but still deferred: v0.2 keeps the config
  drawer live-only.
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
| `rounds.phase` | in-place UPDATE, mirrored by an append-only `round-phase` event (#206) | **Yes** — fold the events, never read the mutable row |
| live telemetry (`est_cost_usd`, `contextTokens`, token split) | overwritten per probe, cleared when the lane leaves `running` (#155) | **Never** — the history never existed. Est never replays; settled only (§3 E's settled/est grammar is the same line) |
| resolved config | read at startup, snapshotted (allowlisted subset + hash) into `run-started` (#206) | **Yes**, for the allowlisted keys — anything outside that list stays live-only |
| backlog / board | external GitHub state | Live-only |

### Round identity & the replay unit

- **`rounds.round_id` is the canonical locator** — SQLite autoincrement,
  globally monotonic, survives restarts, never reused. The UI shows it
  directly ("round 12").
- **No composite "run N, round M" identity.** Both coordinates would be
  synthetic; `round_id` alone already pinpoints a round. Run *grouping* is
  derived from `run-started` events — the authoritative run boundary
  (#431 deleted the old `engine_session` gap heuristic outright; the
  wall-clock ceiling now anchors to in-memory process start and
  `engine_session` survives only as the liveness heartbeat row).
- **The unit of replay is the round.** Its event window is exact via the
  #123 id cursors (`start_event_id` / `start_spend_id`), immune to
  same-millisecond boundary collisions. A run replays as the ordered chapter
  list of its rounds; inter-round events attach to the following chapter.

### Cost in replay — two scales, one cursor-truncated, one frozen

- **Header meter: run tier.** Spend as of the cursor within the replayed
  run, over that run's budget — the same tier rule as live (§3 A), truncated
  at the cursor. Watching spend approach the budget while scrubbing is a
  core replay payoff.
- **Cost panel: round tier, NOT cursor-truncated** (#880, supersedes this
  section's earlier "THIS ROUND BY …" single-strip text). §3 E's "COST ·
  ROUND N" panel reads the selected round's FULL by-stage/by-model log and
  its persisted artifact's footer stats regardless of where the scrub cursor
  sits — it is a closed round's frozen summary, not a moment-by-moment replay
  view. "COST · TODAY" (§3 E) is unaffected by replay at all: it always
  reads live "today" data, whether or not a closed round is currently being
  browsed.
- The header meter still grows monotonically under the scrubber; **no est
  segments exist in replay** — history has only settled values.
- Cursor mapping (header meter only): the scrubber cursor is an `events.id`;
  spend truncates by the current event's timestamp. Display-grade precision,
  no join table.

### Mode purity

- Mode is carried by the **round navigator**, not a toggle (2026-07-21
  amendment, §3 A): the navigator's LIVE slot is live mode; stepping to a
  closed round swaps the data source for the **whole screen**. Live values
  must never render beside replayed state as if they were one moment — in a
  closed round the header shows the *as-of-cursor* round/phase/spend plus
  the persistent tinted "ROUND N · CLOSED" badge; whether the engine is
  currently alive shrinks to the engine-state word. Engine control verbs
  hide entirely (§3 Operations — mode purity applied to the write path).
- The **open round is not scrubbable** in v0.2: at LIVE the cursor is
  pinned to HEAD. Scrubbing backward inside a live round would create a
  third mode ("cursor behind HEAD") with unanswered rules for controls,
  est overlays, and auto-follow; a round becomes fully replayable the
  moment it closes (§10).
- Panels that cannot replay dim with an **on-panel** "live only" badge. A
  footer note alone is not acceptable — the badge belongs on the panel that
  would otherwise lie.

Owner ruling Q4, 2026-08-17 (#729 design review; tracked by #927, not yet landed): the lane
board reconstructs a replayed lane NARRATIVE from the event stream (`dispatched`/`handoff`/
`reclaim-done`, incl. cost/est/merged) in replay and `?demo`, labelled **REPLAYED** — never a
fake live snapshot. This retires the lane board's current "live only" wrap (`App.tsx`'s
`LiveOnly`) once #927 lands; the boundary table's own row for it is #927's edit.

### Renderer contract

One pure fold: `render(stateAt(cursor))`, where `stateAt` folds
`events + spend_ledger` up to the cursor. **Live is `stateAt(HEAD)` plus an
overlay** (est telemetry, config, board). Replay is not a second UI — it is
the same UI with a different cursor. §9's single reducer is this mechanism;
the overlay is the named boundary.

### Engine follow-ups (all additive; #1–2 filed as #206, #3 as #207, #4–5 as #210, #6 as #293, #7 as #294)

1. **`round-phase` event** (#206) — `appendEvent("round-phase",
   { round_id, phase })` covering the **full trail**: the initial `aligning`
   at round open, every `advanceRoundPhase` transition, and the terminal
   `closed`; without it the hero's phase lighting cannot replay and the
   §8 spend phase-bucketing has no windows. **Shipped** (round.ts): the
   event means *"round R entered phase P"* and is emitted by whichever
   process actually enters it — including a restart resuming a crashed
   round at its persisted phase — so no crash window can drop a phase the
   round really ran. **Consumers must fold idempotently**: a re-run phase
   says so twice (rerun-not-resume, #77 dec. 4) and the engine deliberately
   does not deduplicate.
2. **`run-started` event** (#206) — appended once at CLI startup, payload
   `{ config: <allowlisted subset>, configHash }` — the same allowlist the
   config drawer serves (§3 E); a hash alone cannot power historical
   captions or budgets. Gives replay its run grouping and later makes the
   config drawer historically honest (§10). **Upgraded 2026-07-21 to a hard
   prerequisite for the header**: the #154 run-spend anchor
   (`runSpendAnchorId`) exists only in engine-process memory — the
   dashboard server cannot compute `spend.runUsd` (§8) until this event's
   adjacent ledger position persists the anchor. Until it lands, the header
   meter runs whole on the daily tier (§3 A's existing fallback path — no
   new machinery). **Shipped** (cli.ts, both drivers): appended once per
   process start, before anything else that run writes. The allowlist is
   `dashboardConfigSubset()` in `engine/src/config/config.ts` — the single
   list this event and `/api/status`'s own `config` key (§8) both read, so
   the drawer never has to re-derive it (and a config key added later is
   absent from both until someone lists it). `configHash` is a SHA-256 over the
   **full** resolved config with keys sorted, so key order in the YAML
   never shows up as a config change.
3. **Titles in event payloads** (#207, design-director amendment; landed as
   #595, a registry-aware redo of the original #365 implementation, which
   went stale against the #425 event-kind registry and was never merged) —
   **LANDED** for `dispatched.issueTitle` (the tick's own `getReadyIssues`
   row, ordinary and park-canary dispatch alike) and `prTitle` on all three
   PR-opened transitions — `reclaim-done`, `reclaim-failed`, `reclaim-dead`
   — sourced from the lane's PR-association read (forge.ts's
   `associateLanePr`/`LanePrOutcome.title`), which now selects `title` in
   the `gh pr list` reads it already made. Every field is **omitted, never
   null**, when the source has no title. The `merged.prTitle` residual
   **LANDED as #420** (human-authored: `merge-driver.ts` is a
   human-merge-only path the guard denies to workers at the write layer,
   security.md): both merged-outcome sites and the engine-agent
   already-merged observation thread `PRStatus.title` through
   `DriveOutcome`, and the conductor writes it onto the `merged` event as
   `prTitle` — same omitted-never-null contract. Only pre-#420 `merged`
   events fall back to the `prTitle` on that lane's earlier PR-opened
   event.
4. **`worktree-released` event** (#210, round-2 amendment) — **LANDED** —
   payload `{ worker, issue, worktreePath }`, mirroring `worktree-retained`'s.
   Emission: on tick/startup the engine checks each retained path it has
   recorded; when the folder no longer exists (the human cleaned it up), it
   appends the event once. Matching for the §3 Needs-attention clear is
   **by `worktreePath`** (lane names are reused slots; the path is the
   identity); a retained event whose `worktreePath` is null can never be
   matched and its row therefore never auto-clears — the engine must not
   emit retention without a path going forward. Purpose: the strip's only
   missing resolution signal, replay-consistent like every event.
   Dedupe is the event log itself (the newest of the two kinds for a given
   path decides), so repeat ticks and restarts emit nothing further — and a
   lane slot recycled at the same path can be retained, and resolve, again.
5. **`dashboard.controls` config key** (#210, round-2 amendment) —
   **LANDED** — boolean, default `true`, in the strict config schema
   (`docs/configuration.md`); gates the §3 Operations verbs and the §8
   `POST /api/control` route. `false` = pure-spectator dashboard. Schema
   only: the dashboard reads it, the engine does not.
6. **`EMERGENCY_STOP` sentinel** (#293, third amendment) — **LANDED** (engine
   sentinel #724; the §3 Operations button and `estop` verb #733) — immediate
   hard stop, no drain window: detection hard-kills every running/fixing lane's
   process group in the same tick via the existing kill path, with the
   existing post-drain escalation treatment. Precedence EMERGENCY_STOP >
   KILL_SWITCH > PAUSE. Safety machinery — the implementing PR is
   human-merge-only. State-word mapping: an emergency stop renders through the
   existing stopping/stopped words — no new state word (same no-eighth-word
   doctrine as env-park). `start` clears PAUSE/KILL_SWITCH but deliberately
   never EMERGENCY_STOP — the only release lever is the CLI-only `sapwood
   estop clear` (#731); the dashboard's Start control is disabled with an
   explicit persists-indicator while the sentinel is active, per
   `engine.estopActive` served alongside `state`.
7. **Hold-visibility events → #294** (`pr-held` / `pr-released`) — a held PR
   (`escalation.holdLabels`) is indistinguishable from "waiting on review"
   in persisted data: the gate observes the label live and appends nothing.
   #294 adds transition-only events (dedupe-flag paradigm, gate behavior
   untouched) — the hard prerequisite for the lanes panel's ON HOLD card
   and the hero hold pin; until it lands, held PRs render as waiting.

New event kinds must land in the §7 copy map in the same PR (gate②
checklist); payload-only additions like #3 need no copy entry.
- **Localization** — the copy map is the seam; add locales when someone asks.
