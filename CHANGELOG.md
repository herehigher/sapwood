# Changelog

All notable changes to sapwood are documented here. Format:
[Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/). Versioning:
[SemVer 2.0.0](https://semver.org/spec/v2.0.0.html) — see
[docs/dev-guide/10-releasing.md](docs/dev-guide/10-releasing.md) for the pre-1.0 ladder.

## [Unreleased]

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
