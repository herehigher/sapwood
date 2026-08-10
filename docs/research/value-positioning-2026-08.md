# Value & positioning review #2 — 2026-08

**Status:** adjudicated. Method: three independent deep-research passes over three
recently prominent open-source projects in the loop/graph-engineering space
(selected by the owner), each pass grounded in the subject's actual source tree;
synthesis then adversarially reviewed by a second, different-vendor model with
read access to all source trees including sapwood's; 10 objections raised, of
which 9 were absorbed (one rebutted with citations and withdrawn by the
reviewer). Builds on
[value-positioning-2026-07.md](value-positioning-2026-07.md) (the first review).

Per owner directive, research subjects are not named or identifiably described
in this document. They are referred to as:

- **Subject A** — a provider-neutral external state kernel / control plane for
  long-running agent work; fast-moving, essentially single-author.
- **Subject B** — a well-resourced, company-backed general agent runtime with a
  REPL-centric execution model and strong community traction.
- **Subject C** — a documentation playbook operationalizing the naive
  run-agent-in-a-loop technique; no runnable engine of its own.

## 1. Headline — corrected under adversarial review

None of the three subjects ships a default, end-to-end governed merge workflow
(structural producer≠reviewer≠merger with a code-enforced gate). Two of the
three state in their own documentation that they are **not** a security
boundary and delegate isolation to external sandboxes; the third gates
external actions with recorded permission flags, but its only per-tool-call
hook is opt-in and self-documented as bypassable.

**What this does and does not prove** (the review's sharpest correction): this
is **competitor-gap evidence, not moat or demand verification**. Three
projects declining to build governance says the gap exists; it does not say
anyone will pay to have it filled. The July finding stands unchanged: the
positioning rests on zero buyer evidence. See §5 for the owner's ruling on how
that evidence gets gathered.

## 2. Selling-point rulings (adjudicated)

1. **Local crash consistency: demoted from headline selling point to table
   stakes.** Subject B has implemented command journaling, leases,
   claim-before-deliver scheduling, and a "never replay uncertain side
   effects" invariant — serious, shipped engineering. Subject A has
   implemented local write-correctness (content-addressed idempotency,
   revision CAS, TTL leases), though parts of its consistency story are
   product contracts rather than shipped code. Ruling: sapwood may no longer
   lead with "we have crash consistency." The **residual** differentiator is
   scope, stated precisely: sapwood's state is a hybrid — GitHub is the
   cross-actor process truth (board/labels/PRs, idempotently advanced with
   receipts) and local SQLite/WAL is the authoritative runtime ledger. All
   three subjects keep process state in stores only they can read; sapwood's
   process layer survives the death of the machine it ran on and stays
   auditable by people who never installed sapwood.
2. **Role separation remains the core differentiator — with scope stated
   honestly.** The corrected claim: sapwood ships, by default and
   fail-closed *within its guarded tool family*, structural
   producer≠reviewer≠merger — guard hook + role credential tiers + a single
   merge path behind a distinct identity — with branch protection as the
   documented platform backstop (warn-only; see §5). Not claimed: an absolute
   jail. `docs/security.md` records the accepted blind spots (notably
   unknown MCP servers), and the review found competitors already possess
   interception *primitives* (a pre-tool-call hook; a blocking extension API)
   from which a rival could build a gate — what none has built is the
   end-to-end enforced workflow and the adversarial hardening behind it. The
   moat claim therefore stays what the July review said it was: the hardening
   curve plus the dogfood evidence chain (~347 merged PRs of audit trail,
   growing weekly), not the feature.
3. **Deterministic engine vs. model-driven control flow: keep, without
   caricature.** Sapwood's engine does orchestration in deterministic
   TypeScript and spends model tokens only on legs that need thought. Subject
   B deliberately exposes more model-programmable control (its host is still
   deterministic code underneath). This is a real architecture difference to
   explain, not a token-burn accusation to level.
4. **GitHub-as-queue: the sharpest differentiation, restated without
   overreach.** All three subjects introduce their own task store; sapwood
   alone uses the issues/board/PRs a team already has. Corrected form: **low
   task-data migration for GitHub-native teams, and exit leaves the full
   audit trail in GitHub** — not "zero migration/zero exit" (setup still
   requires board/labels/credentials wiring, and a local runtime ledger
   exists by design).
5. **Stop semantics: unique at the work-item level, not at the process
   level.** Survived review with one boundary drawn: Subject B has
   graceful-then-force *process lifecycle* semantics. What no subject has is
   sapwood's *work-item-level* resumable ladder: soft budget → worker-side
   graceful handoff (finish atomic step, commit+push WIP, progress note,
   `.handoff` sentinel, clean exit; prompt-mediated, engine-triggered) →
   supervisor drain (sentinel-only, never touches worker worktrees) →
   EMERGENCY_STOP. The two paths are distinct by design and both documented
   in PLAN.md; the reviewer's fabrication charge on this point was withdrawn
   after citation.
6. **Observability: competitive pressure is real, and one practice is worth
   adopting.** One subject treats the public/private boundary of its
   operator surfaces as a first-class, negatively-tested feature. Adopted for
   the sapwood dashboard as #735 (redaction contract, showcase mode, trap
   fixture — v0.2). Otherwise sapwood's dashboard scope holds its own.

## 3. Threats (re-ranked under review)

1. **GitHub as platform owner — restored to #1.** The July ruling was
   demoted in this review's first draft without evidence; the reviewer
   correctly objected. GitHub implementing structural producer≠merger at the
   token/permission layer remains the fastest, sturdiest way sapwood's core
   gets commoditized. Standing answer unchanged: the merge gate is
   producer-neutral; incumbent-produced PRs are upstream TAM.
2. **Subject A as a watch item, not a ranked threat.** Its provider-neutral
   state layer aims at a weakness sapwood has accepted (harness coupling,
   July weakness #2). But provider-neutral *state* has not produced
   provider-neutral *enforcement* — its only per-tool gate rides the same
   host-specific hook sapwood uses, opt-in. Escalate only if it ships a
   host-enforced merge-authority path. Review cadence: quarterly.
3. **Reliability engineering is available in the ecosystem** — the corrected
   form of "it's being commoditized fast." (Build-time inferences from repo
   ages were struck: one subject is a hard fork of an older runtime; repo age
   ≠ implementation time.) Consequence unchanged: engineering-rigor claims
   have short half-lives as differentiators; evidence-chain claims do not.
4. **Governance is not a developer-virality hook.** A subject with no
   governance and no sandbox story earned large community traction in
   months. This does not prove governance lacks buyers; it does confirm the
   July hypothesis that the governance buyer (team lead / compliance budget)
   is not reached through developer-tool virality, which constrains GTM and
   raises the priority of §5's demand-evidence work.

## 4. Actions (adjudicated 2026-08-10)

1. **Demand evidence via desk research + post-launch feedback** — see owner
   ruling in §5 (supersedes the interview framing of #308 for now).
2. **Branch protection stays warn-only** — owner ruling, §5; the external
   claim language is narrowed instead (folded into #734's scope).
3. **Capability-boundary matrix + live regression probes** — filed as #734,
   milestone v0.3.1 (deferred until post-launch confirmation, owner ruling).
4. **Dashboard public/private boundary** — filed as #735, milestone v0.2.
5. **Retire "thin engine" language everywhere outward-facing.** The honest
   form: *no wheel reinvention; compact within its boundary* — the engine
   does not rebuild issues/PRs/CI/review that the forge already provides.
   Engine size is stated plainly when asked (~60k non-test LOC as of
   2026-08-10, roughly double the July figure).

## 5. Owner rulings recorded this round (2026-08-10)

- **Demand evidence:** sapwood is a solo project; customer interviews are not
  realistic. The #308 intent is discharged through online desk research
  (mining existing public signal), explicitly accepting residual
  need-misfit risk, to be corrected through real feedback after public
  delivery. Positioning stays labeled a hypothesis until that feedback
  exists.
- **Branch protection:** remains warn-only. It is a GitHub-side mechanism and
  marks the boundary of sapwood's security audit surface — sapwood detects
  and warns, the platform enforces. External claims must be worded within
  this boundary.
- **Engine size doctrine:** "compact" means *no wheel reinvention within a
  drawn boundary*, and that is the goal going forward — not a claim about
  line count.
- **Research-subject anonymity:** review documents in this repo do not name
  or identifiably describe the researched projects.

## 6. What did not change

The July review's structure survives contact with three more competitors: the
moat is the fail-closed hardening curve plus the dogfood evidence chain;
feature parity is reproducible and not defensible; the positioning is a
hypothesis until demand evidence exists; naming rulings, layer map, and the
L0–L3 packaging ladder are all untouched by this round.
