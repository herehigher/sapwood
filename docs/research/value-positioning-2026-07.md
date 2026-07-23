# Value & positioning research — 2026-07

**Status:** adjudicated. Initial synthesis was adversarially reviewed by three
independent perspectives (product, market, architecture — the architecture pass
source-audited `engine/src`, `guard.ts`, and PLAN.md rather than taking claims on
faith). 17 objections were raised; the revisions below absorb the ones that
survived adjudication. Gap-filling issues: #304 #305 #306 #307 #308.

Compared against: LangChain/LangGraph, OpenHands, Pi (pi-mono), GitHub Copilot
coding agent, plan-cascade, loop-engineering, dg-ai-notes, plus (added by
review) GitHub-native branch protection and the AI PR-review SaaS cohort
(CodeRabbit / Greptile / Qodo class).

## 1. Positioning — explicitly a HYPOTHESIS, not a conclusion

> sapwood is the governance layer between agent output and the main branch.
> Others prove an agent can write code; sapwood proves its PR deserves to merge.

The tri-review's highest-severity market finding: this positioning currently
rests on **zero buyer evidence** — no interviews, no documented case of a team
abandoning autonomy over merge trust. It also faces a known headwind: Devin-era
"autonomous merge = overpromise" skepticism is anchored in buyers' minds, and
positioning language must confront it head-on rather than ignore it. De-risking
action: customer discovery before further positioning work (#308).

Category language: do **not** ride the "loop engineering" category term (mindshare
would settle on the incumbent repo; sapwood becomes a footnote in someone else's
category). Coin an ownable term in the "merge governance" direction; cite
loop-engineering as methodological prior art, not shared category.

## 2. Layer map

| Project | Layer | Relation to sapwood |
|---|---|---|
| LangChain / LangGraph | Framework (build-your-own agent) | Different layer; pitch to its users is "don't hand-build the governance layer" |
| Pi (pi-mono) | Harness (minimal loop, max extension) | Different layer; philosophical reference |
| OpenHands | Platform (autonomous SWE + enterprise control plane) | Adjacent; sells *access* governance (who may use agents, spend, deployment), not *process* governance (whose code merges, past whom, on what evidence) |
| GitHub Copilot coding agent | Incumbent default of the same loop (issue→PR) | Strategic risk #1 — see §5 |
| GitHub branch protection + CODEOWNERS | Native free guardrails | Defines the TAM ceiling; the sharpest pitch target: "your required-reviewer setup is a rubber stamp" |
| AI PR-review SaaS (CodeRabbit / Greptile / Qodo…) | Advisory review, commercially validated | The correct foil for "advisory vs fail-closed" — they proved teams pay to ask "can this PR merge?"; none can *enforce* the answer |
| plan-cascade | Orchestration (decomposition + advisory gates) | Upstream neighbor; potential feed into sapwood's Ready queue |
| loop-engineering | Pattern catalog + CLI (9k★) | Category validator; borrow its packaging (autonomy ladder, per-pattern cost, failure-mode docs) |
| dg-ai-notes | Educational notes (720★) | Signal that "deconstructing an agent system" is itself a content market |

## 3. Pain points (re-ranked against the v1 persona: solo dev / small-team lead)

1. **Trust gap** — nobody lets an agent merge to main because producer
   self-review is worthless. sapwood's answer is structural, code-enforced,
   fail-closed role separation (guard down ⇒ nothing merges, not everything).
2. **Runaway cost** — for a solo dev running overnight on their own Claude
   subscription, this ties with trust as the reason not to leave the loop
   unattended. Soft budget + graceful handoff (commit WIP, note, clean exit),
   never a mid-work kill.
3. **Unverifiable "done"** — `Ready` requires acceptance criteria + proof
   method; gate② re-checks the PR against them.
4. *(Reclassified)* **GitHub-native process** is not a pain-point cure for a
   solo dev (one person has no two-sources-of-truth pain); it is a
   **zero-migration adoption feature** and should be marketed as such.

## 4. Moat — two claims that must not be conflated

- **Feature parity** (CI green + required review before merge): reproducible in
  a quarter; GitHub branch protection gives a weak version for free. Not a moat.
- **Fail-closed strength parity** (deny-first, crash ⇒ deny, malformed input ⇒
  deny, opaque construct ⇒ deny, surviving differential fuzz): built through an
  adversarial hardening curve — ~100 ported bypass cases, 1500-string
  differential fuzz, seven review rounds closing five independent fail-open
  vectors, live-probe-discovered path escapes. Copying the spec does not copy
  the curve. This, plus the dogfood evidence chain (sapwood has built sapwood
  since M2, with a full audit trail of autonomous merges), is the moat.

The defense is layered, not one (undersold in the original synthesis):
(a) ordinary coding legs carry `Bash(gh *)` and inherit the engine environment
so they can push and open a PR; only fix legs are credential-free (#218/#247);
(b) guard argv-level interception; (c) structural single point — only
`merge-driver.ts` merges, behind branch protection and a distinct identity.

## 5. Honest weaknesses (revised)

1. **Strategic risk #1 — GitHub as platform owner.** Copilot coding agent
   (issue→PR, human merges) currently eats sapwood's periphery, not its core.
   The real risk: GitHub can implement structural producer≠merger at the
   token/permission layer — faster and sturdier than argv interception. For
   GitHub, "a quarter" is an *overestimate* of the cost. Standing answer the
   roadmap must keep true: the merge gate is **producer-neutral** — sapwood's
   governance can adopt Copilot-produced PRs, turning the incumbent loop into
   upstream TAM instead of a rival.
2. **Harness coupling is deeper than a distribution ceiling.** The guard rides
   Claude Code-private extension points (`--settings` PreToolUse injection,
   `--setting-sources`, `--disallowedTools`, sentinel/stream-json contracts).
   Most harnesses have no pre-tool-call interception primitive at all: this is
   an *unbuilt abstraction*, not an expensive migration. Accepted for now
   (locked decision: Claude Code plugin), recorded honestly.
3. **Network egress is uncontrolled** (worker can exfiltrate even though it
   cannot merge). The deny-action paradigm's structural blind spot — decision
   tracked in #304.
4. **Policy-paradigm inversion** — highest-privilege worker on denylist Bash,
   read-only roles on allowlist. Rationale to be documented — #305.
5. **"Keep the engine thin" is no longer a description of reality** (~31k lines
   non-test engine source; align/architect/retro reach beyond the merge-trust
   layer). The usable form of the principle is forward-looking: *new features
   default to restraint; no new machinery without necessity* (the existing
   marginal-complexity principle — reaffirmed, not invented here).
6. **IForge drift (audited in #307)**: 44 methods vs the "~8" design intent;
   25 expose portable forge primitives and 19 encode GitHub semantics. The seam
   isolates runtime orchestration and loop forge operations; init-time auth checks
   and provisioning use the `gh`/`ghText` helper directly. GitLab/Gitea would be a
   semantic port, not an endpoint swap; interface regrouping waits until a second
   forge is actually scheduled.
7. Pre-v1, zero external users, against 70k★/58k★/9k★ neighbors. Star counts
   are treated as weak category-heat signals only — they measure developer
   virality, not governance-buyer intent, and must not carry strong conclusions.

## 6. Adopted actions

- **L0–L3 autonomy ladder = packaging, not product.** The ladder already exists
  (`--dry-run` → supervised single issue → produce-PR-and-stop →
  conductor-merges); name it and document it, zero new machinery (#306). The
  earlier "build an L1 read-only teaser product" idea is **rejected** — it
  contradicts the thin-opinion principle and would delay the v0.2 dashboard,
  which remains the only planned evidence-chain launch artifact.
- **Content channel rises to second priority** (behind discovery #308): the
  dogfood audit trail ("how an agent safely auto-merged 300 PRs") is publishable
  material sitting in git history and doctrine docs. Sequence with the naming
  checkpoint below.
- **AI stub detection** (plan-cascade borrow) is a cheap gate② checklist
  candidate; park until the reviewer-agent work (E-series) stabilizes.
- **Upstream decomposition: build the light version in-house** (2026-07-22
  owner challenge, PM + architecture adjudicated — this REVERSES the round's
  earlier "leave it to ecosystem tools" line). Source audit: ~70% of the
  capability already ships in the PO align pipeline (persist-first proposal
  log, per-issue idempotent create loop with marker dedupe + receipts,
  `origin:agent` governance, source-blind gate⓪, blocked-by dispatch filter);
  crash semantics are the already-solved per-step-idempotent pattern, not a
  new atomicity surface. Genuinely new: a decompose role (medium — 500–900
  lines by analogy to architect.ts), a body-marker parent link, and one
  hardcoded anti-recursion rule (never decompose `origin:agent` issues).
  Human signature preserved: children land outside Ready; moving each card
  stays the human why/what act. External heavy planners keep the same
  interface — GitHub itself (issue + `origin:agent` + plan); the "interface"
  deliverable is a documented intake contract, zero code. Filed as #310,
  v0.2 non-critical path (dogfood candidate: decomposing the dashboard scope
  itself).
- Public numbers hygiene: cite "2300+ tests" (measured ~2331 on 2026-07-22),
  never rounder-up figures.

## 7. Naming ruling (owner decision, 2026-07-22)

Owner: the name is a mnemonic tag at this stage; positioning lives in the repo
description and README. No brand burden pre-launch; the bar is only "memorable,
readable, no ugly connotation."

Market review verdict: **partially agree.** The tag-not-brand claim matches
dev-tool history (Kubernetes, Kafka, Redis carry zero inherent semantics).
Retained conditions, all cheap:

1. **Before going public**, run one real search-ecosystem check on "sapwood"
   (the word is saturated by lumber/woodworking content — a measurable dilution
   risk for the planned content channel, not an aesthetics question).
2. Optional blind test with 2–3 people who know some woodworking: in wood
   terms sapwood is the perishable layer that gets planed off while heartwood
   is prized — a *misaligned* (not negative) metaphor for a trust product.
3. PLAN.md's "re-evaluate name before public" checkpoint **stays** until
   formally revised through the normal doc gate — an owner statement in a
   review conversation does not amend a written decision.
4. If the name stays, *reappropriate* the metaphor proactively in content:
   sapwood is the only **living** layer of the tree — the part that actually
   transports nutrients and does the work; heartwood is dead structure.

Convener (PM) position: agree with the owner; the conditions above cost hours,
not weeks, and condition 4 converts the metaphor risk into narrative material.
Rename is deferred, not reopened, unless discovery (#308) or the pre-public
search check produces contrary evidence.

## 8. Open questions (owner-level)

- **What business is sapwood?** Open-source plugin riding the user's Claude
  subscription is a distribution story, not a revenue story. Open-core? Hosted
  governance/audit plane? Enterprise attestation? The "window won't stay open"
  urgency claim hangs in the air until this is answered. (Supply-chain-trust
  precedents — SLSA/in-toto/Sigstore — suggest the buyer may be the
  security/compliance budget, not the dev-productivity budget, which would
  change GTM entirely.)
- Whether tier (b)/(c) of egress control is ever worth its noise (#304).
