# #729 fidelity closure — deviation ledger

> Process record (design/research artifact, not end-user documentation). Primary deliverable of
> #729's audit phase: every frozen baseline in `docs/design/mockup/` compared against the live
> panel, one row per deviation, each dispositioned.

## Method

`npm run shots` (`dashboard/shots/`, landed by #876 D, extended by this PR for the idle/active
split below) builds the frozen-mockup-vs-live contact sheet used for this audit: the `?demo`
fixture captured at 1440/1024/720 × light/dark × idle/active for every module with a per-module DOM
anchor, paired against `docs/design/mockup/*.png`. Run it locally to regenerate
`dashboard/shots-output/contact-sheet.html` (gitignored output, not committed) and view the pairs
directly — this ledger's rows are the reviewer's judgment calls made from that evidence, not the
evidence itself.

**States — both are real folds, not a label on one screenshot.** "Idle" is `?demo`'s default
position: the round's fully-folded END state (`useDemoReplay.ts`'s own `endPosition` doc) — nothing
left in flight. "Active" is that same round's transport (`Transport.tsx`'s `aria-label="scrub"`
range input) driven to its midpoint event — a real, checkpointed re-fold to an earlier point in the
round (`scrubTo`, `player.ts`), not a fabricated or hand-picked state. Confirmed materially
different captures at 1440-dark: idle shows the round's outcome as "1 ring · 1 merged · 0 pending ·
1 needs human" at $4.20 spend; active (mid-round) shows "0 rings · 0 merged · 0 pending (2
unverified) · 0 needs human" at $2.10 spend, with lane w2 mid-track on issue #9102 instead of
resolved. `needs-attention` legitimately has no active-state capture: the component renders nothing
at all when its item list is empty (frontend-design.md: "empty = not rendered, empty is
trustworthy"), and at this fixture's scrubbed midpoint nothing has escalated yet — an honest
"nothing waiting at this point in the round" fact, not a selector miss (`shots.spec.ts`'s
`OPTIONAL_AT` exemption records this explicitly rather than silently passing).

**Coverage caveat — `lanes` has no demo capture in EITHER state.** The `?demo` fixture is always in
`replay` mode, and the real `LaneBoard` only mounts live (`shots.spec.ts`'s own comment documents
this) — so the `lanes` module's automated capture is the `LiveOnly` "live only" placeholder in both
idle and active, not the real board, regardless of scrub position. No manual live run backs the
`lanes` rows below either — this headless lane has no live engine state to observe against. This is
a genuine, unclosed evidence gap (rows 12–13), tracked as its own follow-up (#882) rather than
papered over.

**Dark-only baselines.** `cost` and `needs-attention` have no light-theme mockup on disk. Per
#361's verification plan (the established convention for this exact gap): the light theme is
audited structurally against the dark baseline's layout intent, never pixel colors. No phantom
light baseline is invented, and the light column is not skipped.

## Deviation ledger

| # | Module | Element | Baseline intent | Current state | Disposition |
|---|--------|---------|------------------|----------------|--------------|
| 1 | hero-panel | Backlog cards, phase-node icons, droplet chips, outcome ring | `hero-panel-{dark,light}.png`: filled amber backlog cards, icon inside each PLAN circle (target/tree/check), droplet-shaped issue chips on lane tracks, a large bold-serif ring number for the outcome count, section headers in bold mono | Live: backlog list not rendered in the captured viewport slice, PLAN circles are bare outlined circles with no icon, no droplet chips on lane tracks, outcome ring is a thin single-stroke circle with a small number, headers render thin and small. Confirmed identical in both idle and active state — a structural/typography gap, not an artifact of which moment was captured | fix — tracked in **#879**; full visual rebuild, exceeds this lane's scope per #729's own decompose clause |
| 2 | hero-panel | Section header typography (PLAN / IMPLEMENT / OUTCOME) | Bold mono, evenly letter-spaced, ~16px | Live: thin serif, smaller, less letter-spacing | fix — folds into **#879** (typography rhythm) |
| 3 | cost | Panel composition | `cost-dark.png`: two stacked panels — "COST · TODAY" (by-stage bars with a target tick mark + avg-round header) and "COST · ROUND N" (closed-round detail: by-stage + by-model breakdown, total/PRs-merged/$-per-PR/review-cost footer) | Live: single minimal bar — "cost · this round / by phase / executing $4.20" — no by-model breakdown, no per-round closed panel, no avg-round header, no footer stats | fix — this is the issue body's own named example ("cost panel's by-stage + per-round composition... superseding the minimal by-model/by-lane first pass"); tracked in **#880**, real composition/data-plumbing work exceeding this lane |
| 4 | needs-attention | Row detail (reason chip, urgency, action ask) | `needs-attention-dark.png`: each row carries a category chip (FIX CAP / REVIEW SILENCE / CEILING / DISSENT), a plain-language reason clause, an explicit "asks:" action, and an age readout in a bordered box | **fixed by #881**: `ATTENTION_CATEGORY` (`src/copy.ts`) adds a 10-category chip taxonomy (DECISION/LANE END/FIX CAP/CEILING/ROLLBACK/INSPECT/ENV/REVIEW/LABEL/CI, adapted to the kinds this engine actually emits rather than the mockup's illustrative labels verbatim); every one of the 17 `attention: true` kinds' sentences now carries a reason clause + explicit "asks:" action, or names the payload gap explicitly ("reason not recorded") per the #881 payload audit; `NeedsAttention.tsx` renders the chip and a bordered age box (`.attention-age`). Live `1440-dark-idle-needs-attention.png` (`npm run shots`) now reads "DECISION \| PR #9202 needs a human decision — reason not recorded · asks: decide the PR's next step" with a bordered "4d ago" box — same row shape as the mockup | resolved |
| 5 | needs-attention | Structural light-theme check (dark-only baseline, #361 convention) | Layout intent: chip + reason + ask + age, same row shape as dark | **fixed by #881**: `1440-light-idle-needs-attention.png` mirrors the dark capture's row shape (chip, reason+ask, bordered age box) — colors differ per theme tokens, structure matches | resolved |
| 6 | header | Doubled engine-state word ("stopped — stopped") | N/A (PM-routed finding, not a baseline-vs-live gap — a functional copy bug) | Confirmed reproducible on current `main` before this PR: `ENGINE_STATE_CAPTION.stopped === "stopped"` duplicated the engine-word span verbatim | **fixed in this PR** — `src/copy.ts`'s `stopped` caption changed to `"not running"`; `copy.test.ts` pins the non-repeat |
| 7 | header | Spend meter scale/detailing | `header-dark.png`: bold `$10.4 + $2.2 est / $100` line, thick capsule progress bar with a hatched "estimated" segment | **Premise correction, 2026-08-14 (dual-expert design-gap review, #890):** the original "keep — structurally correct, a stroke-weight gap" rested on an overturned premise — `Header.tsx`'s `SpendMeter` computed `pct`/`warm` but rendered a TEXT-ONLY span in every theme at every width; no bar, no est tail, no hatch existed anywhere on screen, and lane cards/cost panels carried no est/hatch grammar either (a structural absence, not a stroke-weight nuance). **Fixed by #890:** one shared `<CostBar>` primitive (`dashboard/src/components/CostBar.tsx`) + one SVG `<pattern>` hatch def (`--hatch-*` tokens.css), wired into the header capsule bar (settled solid + hatched est tail + `+ $x.xx est` text, matching `header-dark.png`), lane cards (settled/est figures + bar, engine-provided `estCostUsd` no longer silently dropped), and the cost panels' "Lanes" stage bar (hatched est share, sourced from the same `sumEstCostUsd` the header reads). Plus the est→real calibration feed line ("est $X → real $Y") on lane settlement (`copy.ts`'s `reclaim-done` entry, sourced from `conductor.ts`'s own settlement payload). | **reopened → fixed** — #890 |
| 8 | header | Kill-switch discoverability | PM routing comment: "no kill-switch/pause control discoverable" (walked pre-#866) | **Re-verified against current `main`: resolved.** `Controls.tsx` renders EMERGENCY STOP inside the `aria-label="operations"` fieldset alongside PAUSE/STOP, with a labeled hold-to-arm affordance and full keyboard support (#733/#866, merged after the replay walk this finding came from) | adjudicated-keep — superseded by #866, no action needed |
| 9 | header | Hero "?" legend discoverability | PM routing comment: "hero glossary hidden behind an unlabeled '?'" | `Legend.tsx`'s `<summary aria-label="Legend">?</summary>` — labeled for assistive tech; the bare "?" glyph is `frontend-design.md` §7's own deliberate ruling ("that is the whole onboarding surface — no tour, no modal sequence") | adjudicated-keep — intentional per existing design doc ruling, not an oversight; visual minimalism is the point |
| 10 | activity feed | Event copy fallback for unmapped `ci-pending-*` kinds | Every emitted event kind renders plain-language copy (§7 contract: "adding an event kind without a copy entry is a type error") | Confirmed reproducible before this PR: `ci-pending-observed`/`-escalated`/`-cleared` (`engine/src/state/event-kinds/drive.ts`) had no `copy.ts` entry, so any of the three rendered the raw `Unrecognized event: ci-pending-*` fallback | **fixed in this PR** — 3 entries added to `copy.ts`'s `EventKind`/`COPY` (routine sentences for observed/cleared, `attention: true` + a needs-human sentence for escalated, matching `ci-inert-escalated`'s existing pattern); `frontend-design.md` §7 table and `copy.test.ts`'s `DOC_TABLE_KINDS`/sentence oracle updated to match |
| 11 | activity feed | Feed order vs. scrubber chronology | PM routing comment: "activity-feed order contradicts scrubber chronology at 8/9→9/9" | Not reproduced from the `?demo` fixture in this lane (the fixture's single demo round doesn't reach the 8/9→9/9 replay boundary the original probe walked) | fix — tracked in **#883**; needs a fixture that reaches the boundary to reproduce and pin, not diagnosable from this lane's available inputs alone |
| 12 | lanes | Lane card detail (title, PR link, spend bar, elapsed time) | `lanes-dark.png`/`lanes-light.png`: named lane header + state chip, droplet + issue number + title, PR link with branch-icon glyph, cost estimate/settled figure, a spend progress bar, elapsed time, an `ON HOLD` pin chip variant, an idle-lane row, a `RECENT` summary row | Live: not capturable via `npm run shots` in either idle or active state (see Coverage caveat above); this headless lane has no live engine state to observe against as a substitute | cannot-confirm — a producer-side tooling gap (no `?demo` support for `LaneBoard`), not a producer-fixable disposition today; tracked in **#882** as "extend the shots harness (or a `LaneBoard`-aware fixture) then re-audit" |
| 13 | lanes | "w1 lane row unnamed on the board" | PM routing comment friction item — cross-reference needed | Same evidence gap as row 12 (can't reproduce without an extended-fixture capture) | cannot-confirm — same sub-issue as row 12 (**#882**) |
| 14 | — | Fixture-coverage note: no wedged-lane state in the demo round | PM routing comment's own disposition | N/A | doc-note only, per the PM routing comment's own framing ("a #146-fixture gap, not a panel defect") — no ledger action; a future demo-fixture-authoring issue's concern, not #729's |

## Fold-ins (already adjudicated elsewhere — not re-opened)

- **#144/#145 probe records + #728.** #728 (merged) closed the fix-return-arc-persists,
  backlog-chip-collision, needs-human/tally-overlap, and display-font-token findings from the
  #144/#145 probes. Not re-litigated here.
- **8 PM-routed findings (comment 5285793311, distilled on PR #857).** Rows 3–4, 6, 8–11, 12–14
  above account for all 8 (the "blocks-comprehension" cluster → rows 6, 8, 9, plus 4 folded into
  the needs-attention reason-text row; "friction" cluster → rows 11, 13, plus the cost-composition
  row already covered by row 3; "fixture-coverage" → row 14).
- **Live-probe "Unrecognized event: ci-pending-*" fallback.** Row 10 — fixed in this PR.

## Sub-issues (polish batch, decomposed per #729's own "≤#587-grain, decompose don't bloat" clause)

The audit above shows every module needs substantial, module-scoped visual work — attempting all
of it in one lane risks exactly the "grind an oversized polish batch under one soft budget"
failure mode the round 386 architect pass flagged for this issue. Filed instead of implemented
here:

- **#879** — Hero panel typography + chip/card/icon detailing (rows 1–2, 7's stroke-weight share)
- **#880** — Cost panel composition rebuild — by-stage/by-model/per-round/avg-round-header (row 3)
- **#881** — Needs-attention row detail — category chip, reason clause, explicit ask (rows 4–5)
- **#882** — Lane board capture-tooling gap + card detailing re-audit (rows 12–13)
- **#883** — Activity-feed/scrubber chronology ordering (row 11)

## AC status

- Ledger complete over every frozen baseline × both themes × idle+active, each row dispositioned: **done, scope-qualified (#889)** — idle and active are both real, distinct folds (`npm run shots`'s extended capture pass; see Method above), not one screenshot relabeled. The one honest exception is `lanes` (rows 12–13), which has no demo capture in either state and is dispositioned `cannot-confirm` rather than papered over — a producer-side tooling gap, tracked in #882. **Scope qualifier:** "complete" here means complete over the 8 frozen mockup PNGs in `docs/design/mockup/` (this ledger's own search space, per the Method section above) — it is never a claim of completeness over every panel surface the live app renders. #889's dual-expert gap review found exactly this gap: the header's round navigator/replay-transport band (`Transport.tsx`, unstyled and rendering inline above the fold) had no ledger row at all, because it has no frozen mockup crop this audit's method ever compared against — a real, un-audited surface this ledger's own completeness claim did not cover, not a contradiction of the claim as scoped.
- All 'fix' rows implemented and probe-verified; all 'keep' rows carry reasons; all 'doc-amend' rows have the matching `frontend-design.md` edit merged: **partial** — the 2 rows small/mechanical enough for this lane (rows 6, 10) are implemented and tested in this PR; the remainder are filed as sub-issues per the decompose clause, not implemented here.
- Owner sign-off recorded on this issue: **cannot-confirm, operator-owned.** Tier-C evidence is producer-unforgeable by design (`docs/security.md`'s evidence tiers) — this lane cannot self-attest an owner witness. This is the one AC this PR cannot close; it needs the operator's own recorded walk against the mockups.
