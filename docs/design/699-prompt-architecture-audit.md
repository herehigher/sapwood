# #699 — prompt architecture audit: ledger

Owner-directed clause-level audit of the engine's 14 shipped role-prompt files
(`engine/prompts/*.md`) against three governing principles (below), per issue #699. This is an
**audit ledger**, not a rewrite: no prompt file is edited by the PR this ledger ships in. Every
finding that would change prompt behavior is filed as its own follow-up issue instead (#699's own
AC: "No behavior-changing prompt edit ships in the audit PR itself").

**Gate② correction (sol, this PR's round 1).** The first version of this ledger classified
`doctrine-template.md` and `goal-template.md` as human-facing scaffolds "out of the B/C frame" and
did not clause-classify them. sol proved that claim false for the rendered path: both templates are
copied verbatim by `sapwood init` into the repo's live `goal.file`/`doctrine.file`, and until a
human edits the copy away, three loaders (`align.ts`'s `{{plan.md}}`, `architect.ts`'s
`{{plan.architectureChapter}}`, `doctrine.ts`'s `{{doctrine}}`) substitute that content RAW,
uncommented, into live worker/architect/po-align prompts. Both are in-scope prompt carriers. This
revision clause-classifies both at the same SHA with the same rigor as the other 12 files — see
their rows below and Finding 2.

**Audited SHA:** `2b4a1a4496d1769779cac2d966e0778e6052aa42` (`main`, immediately after #701/PR #821
merged the working-language policy — this audit reviews #701's `{{lang.*}}` directives as already
settled and does not re-litigate them; see #699's own sequencing note).

**Scope:** the 14 files #699 names — `worker.md`, `fix.md`, `engine-reviewer.md`, `architect.md`,
`po.md`, `po-pool.md`, `po-decompose.md`, `verification-plan-drafter.md`,
`verification-plan-reviewer.md`, `verification-plan-reviewer-confirm.md`, `harvest.md`,
`retro.md`, `doctrine-template.md`, `goal-template.md` — 2,264 lines total. Out of scope (per
#699's own charter): `engine/prompts/issue-templates/*.md` and any prompt-like prose outside
`engine/prompts/`.

## The three principles (now also in `docs/REVIEW-DOCTRINE.md`)

1. **A — legitimate prompt content.** Role/duty/scope/goal/deliverable/norm/constraint. Stays.
2. **B — judgment preemption.** Asserts a conclusion, steers a verdict, or answers a question the
   role is supposed to adjudicate from evidence. Disposition: delete, or rewrite as a
   judgment-preserving goal/constraint.
3. **C — machinery in prose.** Describes a deterministic check/flow/value the engine, config,
   schema, or guard could enforce (or already does — a drifting duplicate). Disposition: name the
   target carrier and file a follow-up to move it there — never "fix" by rewording.

Landed verbatim as the standing gate② test in
[`docs/REVIEW-DOCTRINE.md`](../REVIEW-DOCTRINE.md#prompt-architecture-doctrine-699), including the
Q3-safety-floor exception this audit's own headline finding needed (below).

## Method

Each file was read in full at the audited SHA. Clauses were grouped by heading/instructional unit
(not word-by-word) and classified. Before writing up any apparent duplicate-content finding, this
audit cross-checked `engine/src/roles/prompts.test.ts` (1,391 lines) for an existing test that
already covers the same ground — this repo's prompt suite already carries substantial "mirror-pair
discipline" and completeness-claim regression tests (#409, #529, #559, #618, #628, #653, #672,
#701), and several candidate findings turned out to already be adjudicated, tested, and closed.
Those are recorded below as **considered, not findings** rather than silently skipped, since a
"no B/C findings" line is only honest if it shows the check was actually run.

## Per-file classification

| File | Lines | A | B | C | Disposition |
|---|---:|---|---:|---:|---|
| `worker.md` | 99 | role/method/finishing-up, all A | 0 | 0 | Clean. |
| `fix.md` | 107 | role/method/finishing-up + structured-output contract, all A | 0 | 0 | Clean. |
| `engine-reviewer.md` | 264 | role/evidence-tier judgment/findings taxonomy, all A | 0 | 0 | Clean — this file is the **worked exemplar**: its own "What the engine enforces vs. what you judge" section (design #402 §6a) already performs the A/C split this audit asks every file to satisfy, and states which half is which explicitly. |
| `architect.md` | 304 | role/two-mission charter/non-negotiables/structured-output, all A | 0 | 0 | Clean. Notably self-disciplined against C: line 253-255 explicitly declines to say which label a verdict maps to ("fixed, engine-side logic, not something your output can name"). |
| `po.md` | 324 | role/two-mode charter/dedup/concern-channel, mostly A | 0 | 1 (shared) | See Finding 1. |
| `po-pool.md` | 73 | role/one-job charter/non-negotiables, all A | 0 | 0 | Clean — the tightest file in the set. |
| `po-decompose.md` | 155 | role/one-session judgment/granularity, mostly A | 0 | 1 (shared) | See Finding 1. |
| `verification-plan-drafter.md` | 182 | role/brief-bound charter/template-normalization, mostly A | 0 | 1 (shared) | See Finding 1. |
| `verification-plan-reviewer.md` | 259 | role/four-outcome charter/evidence discipline, mostly A | 0 | 1 (shared) | See Finding 1. |
| `verification-plan-reviewer-confirm.md` | 153 | role/two-outcome charter, mostly A | 0 | 1 (shared) | See Finding 1. |
| `harvest.md` | 86 | role/one-job charter/non-negotiables, all A | 0 | 0 | Clean. |
| `retro.md` | 146 | role/two-rules charter, all A | 0 | 0 | Clean — proactively avoids the no-positive-completeness trap ("you are not limited to the three categories named in this issue's scope if you find something more important"), a good worked counter-example to the recurring class #699's own Why cites. |
| `doctrine-template.md` | 75 | lines 17-75 (`# Review doctrine` heading onward): the same technical-invariants/adjudication-doctrine prose `docs/REVIEW-DOCTRINE.md` governs — A by that doc's own carrier rules | 0 | 1 (shared, lines 1-16) | See Finding 2. |
| `goal-template.md` | 37 | section headings + 4 of 5 comment blocks (Goal/Non-goals/Constraints/Current-milestone, lines 12-13/17-18/21-23/35-37): pure authoring guidance to a human, no engine-behavior claim — A | 0 | 1 (shared, lines 27-31) | See Finding 2. |

**Totals: 0 B findings across all 14 files. 2 C-class findings: Finding 1, shared across 5 files
(po.md, po-decompose.md, verification-plan-drafter.md, verification-plan-reviewer.md,
verification-plan-reviewer-confirm.md); Finding 2, shared across 2 files (doctrine-template.md,
goal-template.md).**

Zero B findings is a real result, not an artifact of a shallow pass: this repo's prompt suite has
already been through #454/design #402 §6a's enforced-vs-judged partitioning (engine-reviewer.md),
#618's tool-inventory-completeness sweep, and #653's veto-only (never a green light) framing for
comment-derived signal — all of which are exactly the shape of fix a B-class finding would produce.
The audit looked for a NEW instance of the class and found none.

## Finding 1 (C-class) — the human-merge-only paths list has already drifted across 5 carriers

**What.** `docs/security.md`'s canonical "Human-merge-only paths" list
(`docs/security.md:1651-1680`, marker-delimited
`<!-- sapwood:skill:human-merge-only-paths:start/end -->`) is hand-copied, independently, into five
prompt files that each need to check an acceptance criterion against it:

| File | Lines | Wording |
|---|---|---|
| `po.md` | 142-145 | Full enumeration incl. `sapwood.config.example.yaml`/`.json` |
| `po-decompose.md` | 77-79 | Enumeration **missing** `sapwood.config.example.yaml`/`.json` |
| `verification-plan-drafter.md` | 126-132 | Full enumeration incl. `sapwood.config.example.yaml`/`.json` |
| `verification-plan-reviewer.md` | 86-89 | Full enumeration incl. `sapwood.config.example.yaml`/`.json` |
| `verification-plan-reviewer-confirm.md` | 68-70 | Uses **"security-relevant config"** instead of an enumeration |

This is already-observed drift, not a hypothetical risk. #809 (gate② finding F4) added
`sapwood.config.example.yaml`/`.json` to the list — `prompts.test.ts`'s `SNAPSHOT_HASHES` comments
confirm it touched `po.md`, `verification-plan-reviewer.md`, and `verification-plan-drafter.md`
(each carries a `"#809 (gate② F4): the human-merge-only paths list now also names
sapwood.config.example.*"` comment) — but never touched `po-decompose.md` or
`verification-plan-reviewer-confirm.md`, whose `SNAPSHOT_HASHES` comment blocks carry no #809
reference at all. Their content confirms the gap directly.

`verification-plan-reviewer-confirm.md`'s "security-relevant config" phrasing is worse than merely
stale: `docs/security.md`'s own canonical list explicitly warns against exactly this reading —
*"Do not read 'security-relevant config' below as scoping the block to a subset of the file's
contents — it names why the file is protected, not how much of it is"* (`docs/security.md:1663-1666`).
This is the same misreading that already caused a real incident once (retro round #281 / issue #386
/ PR #562, cited in `po.md`'s own `prompts.test.ts` snapshot comment) — `sapwood.config.yaml` is
blocked as a **whole file** by path pattern, not by which fields look security-relevant.

**Why this is C, not B.** Nothing here asks a role to preempt a judgment; it is a factual
enumeration the engine's own `guard.ts` enforces mechanically and `docs/security.md` already
canonically states. Five independently-editable hand copies of one deterministic fact is exactly
principle 3's "at best redundant and at worst a drifting second copy" — now proven, not just risked.

**The naive fix is wrong — record the tension, per #699's own carve-out.** #639/#640 already built
the intended architectural remedy for this exact class of problem: `engine/src/roles/skills-plugin.ts`
extracts this same marker-delimited `docs/security.md` section verbatim into a Claude Code skill
(`human-merge-only-paths`) attached via `--plugin-dir` to every non-review session
(`shouldInjectSkillsPlugin`: every `SkillsSessionKind` except `"review"` — which covers all 13
non-`engine-reviewer.md` prompts in this audit's scope). Its own module doc is explicit that it
"changes no prompt text and authors no new doctrine; it only gives a role session a second,
on-demand way to read doctrine that already lives in one place." Given the skill already exists and
is already attached, principle 3 applied literally would say: delete the five inline enumerations,
point each prompt at the skill by name.

That move is rejected. A Claude Code skill is **pull-model** — the session must actively decide to
invoke it — and this enumeration is a Q3-class safety floor (per #699's own charter: "evidence-tier
floor stays prompt-resident per the Codex Q3 ruling — a pointer is not a load-bearing substitute for
rules whose omission produces unsafe output"). Getting this specific fact wrong has a real, already
-realized cost (retro #281 above): a `ready` acceptance criterion that quietly assumes a producer can
edit a human-merge-only path is not a style nit, it is a guaranteed unfixable gate② bounce. The
enumeration must stay unconditionally visible in the prompt text, not conditionally fetched.

**Disposition.** Not deletion. Close the drift the same way this codebase already closed the
identical risk for the AC-evidence-tier paragraph (#628) and the comment-contradiction veto duty
(#653): a "mirror-pair discipline" test in `prompts.test.ts` that pins all five carriers'
protected-path token sets against each other (and ideally against `docs/security.md`'s own
`extractMarkedSection` output, the same extraction `skills-plugin.ts` already performs, so a future
addition to the canonical list fails every un-mirrored carrier the same day it's added), plus the
two content fixes themselves. Filed as **#828** (see "Follow-up issues filed" below).

## Finding 2 (C-class) — scaffold HTML comments are live-injected raw into worker/architect/po-align prompts

**What.** `doctrine-template.md` and `goal-template.md` author their guidance to the HUMAN who will
customize a fresh `sapwood init`'d repo as inline `<!-- ... -->` HTML comments —
`goal-template.md:6-7` says so explicitly: *"Fill in each section for this project, then delete
these HTML comments (or leave them — they're invisible in rendered markdown)."* That claim is true
only for a human viewing rendered markdown; it is false for the channel that actually matters here.
None of the three loaders that substitute these files' content into a live prompt strip HTML
comments:

- `align.ts::readPlanMd` returns `readFileSync(path, "utf8")` unmodified, substituted whole as
  po-align's `{{plan.md}}`.
- `architect.ts::loadArchitectureChapterWithStatus` (via `util/markdown.ts::extractMarkdownSections`)
  extracts only the `## Architecture` section, but does not strip comments within it, substituted
  as `{{plan.architectureChapter}}`.
- `doctrine.ts::loadDoctrine` returns `readFileSync(path, "utf8")`, length-capped only
  (`capDigest`), substituted as `worker.md`'s `{{doctrine}}` / `architect.md`'s `{{round.doctrine}}`.

So for any repo that has run `sapwood init` and not yet customized its goal/doctrine files —
`sapwood init`'s own steady-state output — the architect session's `{{plan.architectureChapter}}`,
which `architect.md` itself frames as *"the ground truth an issue's approach must not contradict —
not a suggestion,"* is literally:

> `goal-template.md:27-31`: "The system's shape as decided so far... (the architect peripheral
> reads exactly this section every round and flags issues that contradict it). If this section is
> missing or empty, the architect proceeds with an explicit 'no architecture chapter available'
> placeholder — advisory only, it never blocks a round."

— the architect session's own engine-degrade-behavior restated in prose (`architect.ts`'s literal
fallback string, `"(No \"## Architecture\" heading found in ... — proceeding with no architecture
chapter available.)"`, is a near-paraphrase of what this comment describes), delivered TO that same
session AS IF it were locked architecture. A worker/architect session in the same fresh-init state
also receives `doctrine-template.md:4-9` — `` Configured as `doctrine.file` in sapwood.config.yaml
(default: docs/REVIEW-DOCTRINE.md) `` plus the absent-file `NO_DOCTRINE` fallback description — as
if it were review doctrine.

**Why this is C, not B.** Both cited passages restate deterministic engine facts already enforced
in code (`config.ts`'s `doctrine.file` default; `doctrine.ts`'s `NO_DOCTRINE` fallback;
`architect.ts`'s missing-heading placeholder) — exactly principle 3's definition. It is a sharper
case than Finding 1's hand-copy drift: this duplicate isn't merely present in a file nobody
renders — it is LIVE-SERVED as role content, to the exact session the comment happens to describe.
No B concern: neither passage preempts a role's judgment about a specific case; the harm is
input-channel contamination, not verdict-steering. `goal-template.md`'s other four comment blocks
(Goal/Non-goals/Constraints/Current-milestone) are pure authoring guidance with no engine-behavior
claim — read A, not C, though they share the same delivery-channel defect at a lower severity (see
disposition).

**Disposition.** Not a prose rewrite of either template (out of scope for this audit, and it would
only fix newly-`sapwood init`'d repos going forward, not already-scaffolded ones still carrying the
unedited file). Fix at the loader: strip HTML comments from the content each of the three
substitution points actually renders, leaving the on-disk file's human-facing comments untouched
for an editor/GitHub reader. `docs/REVIEW-DOCTRINE.md` — this repo's OWN live doctrine file, out of
#699's `engine/prompts/` scope — carries the identical leading-comment shape and is subject to the
identical mechanism; noted as a pointer, not a separate finding, per #699's own charter for
out-of-scope material the audit trips over. Filed as **#830**.

## Considered, not findings — duplicate-looking content this audit checked and found already governed

Recorded explicitly so a "no further B/C findings" claim below is checked, not assumed silent.

- **`worker.md:48-52` / `fix.md:64-67` — "Authoritative signals over inferred ones," each an
  independent paraphrase of `docs/REVIEW-DOCTRINE.md`'s "Authoritative signals over inferred text"
  invariant.** Looks like Finding-1-shaped duplication. It is not: `prompts.test.ts`'s `#409` test
  ("the rule is worded per role rather than one paragraph duplicated, and no shared prompt-include
  mechanism was added") explicitly asserts no file repeats another's sentence verbatim and that no
  `{{include|partial|shared}}` template directive exists — a **deliberate, tested** ruling that
  each role should get wording "it can act on," not a shared paragraph. No action.
- **"Acceptance-criteria evidence: default A/B, justified C only, D never"** — byte-identical across
  `po.md:153-164`, `po-decompose.md:89-98`, `verification-plan-drafter.md:100-111`. Already
  mechanically pinned: `prompts.test.ts`'s `#628` test asserts the shared sentences are
  byte-identical across exactly these three carriers ("mirror-pair discipline") and a separate
  `#628` test asserts no carrier restates the tier definitions themselves. No action.
- **"UI-conditional criteria need real-wiring evidence"** — byte-identical across the same three
  authoring files, reworded (not duplicated) in `verification-plan-reviewer.md`. Same `#628`-style
  coverage as above (retro round #363's own test additions). No action.
- **The `#653` comment-contradiction veto duty** — byte-identical across
  `verification-plan-reviewer.md:123-130` and `verification-plan-reviewer-confirm.md`'s equivalent
  paragraph. `prompts.test.ts`'s `#653` test asserts both carry the duty **verbatim**, and a second
  `#653`/`#657` test asserts neither carrier smuggles in a positive-completeness/approval claim
  alongside it. No action.

The contrast with Finding 1 is the point: this repo already has the right tool
(mirror-pair-discipline tests sourced against one canonical wording) for exactly this failure class
— it was applied to three of the four recurring duplicate blocks and missed the fourth
(human-merge-only paths), which is why that one, and only that one, actually drifted.

## Follow-up issues filed

- **#828** — fix `po-decompose.md`'s and `verification-plan-reviewer-confirm.md`'s
  human-merge-only-paths text, and add a `prompts.test.ts` mirror-pair test covering all five
  carriers against `docs/security.md`'s canonical section. (Finding 1.)
- **#830** — strip HTML comments at the three loader/substitution points (`doctrine.ts::loadDoctrine`,
  `align.ts`'s `{{plan.md}}`, `architect.ts`'s `{{plan.architectureChapter}}`) so scaffold authoring
  guidance in `doctrine-template.md`/`goal-template.md` stops reaching a live prompt as if it were
  role content, with an `init.test.ts`-anchored fixture/integration test. Different root cause from
  #828 (live-injection of unstripped comments, not hand-copy drift across independent files) —
  filed separately, not folded in. (Finding 2.)

## Residual risks / known edges

- **`fix.md` never gets `{{doctrine}}` injected**, unlike its sibling `worker.md`. This is
  consistent with #409's own ruling (fix.md's "authoritative signals" bullet is deliberately its
  own worded-for-context paraphrase, not a doctrine restatement) and is not a B/C finding — flagged
  here only as an open design question, not something this audit adjudicates: should the fix leg
  also see the full review doctrine, or is a role-specific summary the intended shape for a
  narrower-scoped session? Left for a human/future issue, not filed as a follow-up by this audit
  (no drift, no preemption — nothing in the three principles requires an answer either way).
- **This audit is clause-grouped, not token-grouped.** A sub-clause inside an otherwise-A-classified
  paragraph could theoretically hide a B or C instance too small to have surfaced in a full-file
  read. The per-file table above reflects a careful read of all 2,264 lines, not an automated scan;
  a future audit re-run should re-check this ledger's own classifications rather than trust them
  as a closed set (the same "no positive-completeness claims" discipline this repo already applies
  to its prompts applies to this ledger too).
- **`doctrine-template.md`'s seeded review-doctrine BODY (lines 17-75)** is the same prose
  `docs/REVIEW-DOCTRINE.md` already governs under its own carrier/maintenance rules; this audit
  classifies it A (legitimate judgment-rule content for an LLM reviewer, by that doc's own explicit
  stance — "deliberately PROSE, not a lint/DSL") but does not re-litigate its substance, consistent
  with #699's charter that existing doctrine is input, not itself a re-derivation target.
- **`docs/REVIEW-DOCTRINE.md`'s own leading HTML comment shares Finding 2's exact defect** (verified
  above) but the file lives under `docs/`, not `engine/prompts/` — outside #699's named scope. Per
  #699's own instruction for out-of-scope material the audit trips over ("it files a pointer, not a
  finding"), this is recorded as a pointer inside #830 rather than a third finding of its own.
