# Changelog

All notable changes to sapwood are documented here. Format:
[Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/). Versioning:
[SemVer 2.0.0](https://semver.org/spec/v2.0.0.html) — see
[docs/dev-guide/10-releasing.md](docs/dev-guide/10-releasing.md) for the pre-1.0 ladder.

## [Unreleased]

## [0.3.0-alpha.3] - 2026-08-28

### Changed
- `release publish` no longer runs `npm publish` locally — the tag-push run's `npm-publish`
  job publishes via npm trusted publishing (OIDC) with provenance; `--otp` removed; `release
  dist-tag <version>` added.

### Fixed
- The `sapwood` npm tarball ships `README.md` and `LICENSE`: `engine`'s `prepack` stages the
  repository-root copies into the package root, so npmjs.com renders the README and shows the
  license instead of "This package does not have a README".

## [0.3.0-alpha.2] - 2026-08-28

### Changed
- `docs/guide/configuration.md` gains rows for 23 schema-valid keys that had none: the empty-spin
  breaker, pool-removal and concern-post caps, the architect drop cap, proxy audit-comment caps,
  per-role `model`/`effort`/`promptFile`, and `roles.skills.enabled`.
- README badges and status reflect the published pre-release; the OpenSSF Scorecard badge uses
  the official `scorecard.dev` URLs.
- Until the first plain release, the publishing human moves npm's `latest` tag to the newest
  pre-release after each publish, so a bare `npx sapwood` installs a working engine instead of
  the `0.0.1` placeholder.

### Fixed
- `sapwood init` and `sapwood run` in a directory with no config, or an invalid one, stop with
  `sapwood validate`'s concise config-error formatting instead of a Node stack trace;
  `sapwood init --help` describes the flow `init` actually runs.
- The getting-started bootstrap config validates as written, and `sapwood run --dry-run` applies
  the same engine-agent CI refusal as `sapwood validate` instead of exiting 0 with a warning.
- The goal file, review doctrine, and architecture chapter reach prompts with HTML comments
  removed, so the authoring guidance in `sapwood init`'s scaffolds no longer reads as doctrine
  or locked architecture. Comments inside Markdown code spans, fenced blocks, and indented code
  are kept; on-disk files are unchanged.
- `release publish`'s npm step runs on an interactive terminal so 2FA web-auth can complete, and
  `publish --otp <code>` is accepted; the runbook names the `github-pages` `v*` tag deployment
  policy the `deploy-demo` job needs.

### Security
- The PO/align backlog digest and plan-triage candidate selection apply the author-trust filter
  to issues: text is shown only for authors GitHub classifies as owner, member, or collaborator,
  the authenticated operator, or a known reviewer bot; other issues appear at most as an
  aggregate count, never as rendered text. The open-backlog read pages GraphQL with a fixed
  ten-page ceiling and fails closed if the ceiling is reached before exhaustion; the
  recently-closed dedup read is a separate bounded one-page window.
- The shipped PO and verification-plan prompts carry the complete human-merge-only path list
  from `docs/security.md`; the guard-hook source, the compiled guard, guard-hook, reviewer, and
  merge-driver artifacts, both `.yml` config variants, and `.github/CODEOWNERS` were absent
  before this fix. The prompts are checked against the canonical section so a future addition
  cannot leave any carrier stale.

## [0.3.0-alpha.1] - 2026-08-27

### Changed
- Runtime directory rename — see [Configuration — The `.sapwood/` runtime
  directory](docs/guide/configuration.md#the-sapwood-runtime-directory) for the layout.
  **Upgrading:** stop the engine before upgrading; the new CLI reads and writes `.sapwood/`
  only; no automatic migration. Cutover checklist (idempotent and resumable — safe to re-run
  if interrupted):

  ```
  # engine stopped (pid gone, no sapwood.lock holder)
  mkdir -p .sapwood/cache .sapwood/keys
  for f in sapwood.sqlite sapwood.sqlite-wal sapwood.sqlite-shm sapwood.lock KILL_SWITCH PAUSE EMERGENCY_STOP ESCALATION \
           DIRECTIVE.md attention-dismissals.jsonl directives rounds proxy-bundles logs sessions; do
    [ -e "data/$f" ] && mv "data/$f" .sapwood/
  done
  for d in review generated; do [ -e "data/$d" ] && mv "data/$d" .sapwood/cache/; done
  for k in data/worker-deploy-key*; do [ -e "$k" ] && mv "$k" .sapwood/keys/; done
  # sapwood.config.yaml: worker.deployKeyPath → .sapwood/keys/worker-deploy-key[-host]
  ```
- Removed the repository's root `AGENTS.md`; the hosted-bot review-round discipline it carried
  is now documented as a snippet for a target repository's own instruction file (configuration
  guide → Hosted-bot review guidelines).
- Review doctrine now ships as two carriers: `engine/prompts/doctrine-core.md` (generic,
  framework-owned, upgraded by every release) is injected ahead of `doctrine.file` (now genuinely
  this repo's own residue); `loadDoctrine` returns the concatenation, always present on every
  engine-composed surface. The hosted gate② review-trigger comment no longer carries any doctrine
  text — a hosted bot's standing review guidance belongs in its own instruction file instead.
  **Upgrading:** if you scaffolded `doctrine.file` from `engine/prompts/doctrine-template.md`
  before this change, delete its `## Adjudication doctrine` section (principles 1–4) and its
  "Authoritative signals over inferred text" bullet — both now ship in the framework core and
  would otherwise be redundant.
- The engine-agent review session's structured findings gain a per-finding `owner` tag
  (`producer` default, or `operator` — the finding's entire unmet requirement is evidence only
  an operator can post, e.g. a tier-C human-witnessed probe record). A rejected verdict whose
  blocking findings are ALL operator-owned now escalates straight to `needs-human` without
  dispatching a fix leg; a mixed verdict still dispatches for its producer-owned share, with the
  operator-owned findings excluded from convergence tracking.

### Added
- Bare `sapwood` npm package, including the packaged dashboard; post-publish dashboard canary
  and catalog promotion of the thin marketplace shell.
- `/sapwood-dashboard` marketplace slash command and a Windows pack/install/dashboard smoke that `release publish` runs as its first, gating step.
- Plugin skeleton, YAML/JSON config schema, `IForge` GitHub adapter, WAL-mode
  SQLite state layer; `sapwood init` onboarding — auth preflight, org
  detection, idempotent board/label/milestone provisioning.
- Conductor tick loop + headless worker: one Ready issue per isolated worktree
  lane, guard wired live into every session.
- Review gate + merge driver: CI-green plus a fresh non-author review gates an
  autonomous merge; `produce-PR-and-stop` selectable; cost ceiling, kill switch,
  TOCTOU-pinned merge.
- `run`/`status`/`validate`/`dashboard` CLI, plugin slash commands, first-run
  trust ramp, kill-switch/pause sentinels, goal-based stop conditions.
- Round orchestrator: peripheral roles (goal alignment, architecture review,
  gate⓪ verification-plan review, harvest, retrospective) wrapped around the
  tick loop; idle-round standby, gated-PR re-entry, round summaries, dispatch
  quotas, role toggles.
- Review-doctrine injection and environment-failure park — env-vs-task failure
  classification with bounded-backoff auto-resume.
- Round-pool selection, architect batch review, per-round budget/backlog
  accounting hardening.
- Metered, audited read-only MCP proxy for judgment roles; write-ahead
  hardening on the engine's own forge writes.
- Fix loop: workers resolve their own review findings under a three-tier
  hold/needs-human/blocked escalation, so humans adjudicate but never resolve
  reviews themselves.
- `engine-agent`: an engine-composed, static, different-Claude-model gate②
  reviewer, promoted to the default review mode.
- Egress tripwire (monitor-only), the L0–L3 autonomy ladder, native PO-issue
  decomposition.
- v0.2 dashboard — event schema, `GET /api/loop/state`/`/events`, React
  lane-board and event-feed UI — built end-to-end through sapwood's own loop as
  the flagship dogfood run.
- Dogfood hardening surfaced by that run: worker capability containment
  (credential-free producer legs, `gh` alias/extension denial), engine
  robustness (cursor/snapshot drift recovery, merge-gate TOCTOU, resume/fix-leg
  interaction), and host-delegated capability management with configurable
  execution profiles (`host.permissionMode`, `bashSandbox`).

### Security
- Fail-closed `guard.ts` PreToolUse hook, zero-dependency, with a reproduced
  bypass suite and differential/fuzz tests — green before any autonomous run.
- Human-merge-only enforcement for the guard, reviewer, merge driver, security
  config, `.claude/settings*.json`, and `.github/workflows/**`.
- Branch-protection detection (warn-only) as the documented backstop for the
  inherited-host-tool-surface trust model.

