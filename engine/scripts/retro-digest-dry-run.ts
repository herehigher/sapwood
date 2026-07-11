#!/usr/bin/env -S npx tsx
// retro-digest-dry-run.ts — #111 PR-A's required product-risk gate (issue #111: "whether the
// digest matches live-browsing analysis quality is a product risk — needs a dry-run comparison
// before committing"). Renders the REAL retro-digest.ts machinery against REAL GitHub data for
// a REAL round window in THIS repo (herehigher/sapwood): the #110 round — PRs #112-#117 (the
// #110 structured-output migration's five sub-PRs + PR0), plus issues #110/#111 (the round's
// own parent/tracking issues), 2026-07-11.
//
// sapwood's own round loop did NOT dispatch this particular round (it was driven by direct
// Claude Code sessions, not `sapwood run`), so there is no real events ledger for it. This
// script SEEDS an in-memory State with events shaped exactly like the ones conductor.ts would
// have appended had the round loop driven this work (merged/drive-needs-human, same payload
// shape) — the seeding is a harness affordance to reconstruct a round window from real GitHub
// history, not a claim that the round loop actually ran. Every PR diff, review datum, issue
// comment/label, and commit in the OUTPUT below is real data, fetched live via `gh` through the
// exact same GithubForge/buildRetroDigest code path retro.ts uses in production.
//
// Usage: npx tsx scripts/retro-digest-dry-run.ts   (from engine/, gh must be authenticated)
import { GithubForge } from "../src/forge.js";
import { State } from "../src/state.js";
import { ConfigSchema } from "../src/config.js";
import { buildRetroDigest } from "../src/retro-digest.js";

const RETRO_EVENT_KINDS = ["handoff", "drive-needs-human", "plan-review-escalated", "ceiling-escalated"];

async function main(): Promise<void> {
  const cfg = ConfigSchema.parse({
    board: { owner: "herehigher", repo: "sapwood", projectNumber: 4 },
  });
  const forge = new GithubForge(cfg);
  const state = new State(":memory:");

  // The round window: just before PR #112's creation (2026-07-11T06:52:21Z) through the
  // #110 round's close (PR #117, merged 2026-07-11T12:26:33Z).
  const round = state.startRound("2026-07-11T06:00:00.000Z");

  // Seed events shaped like conductor.ts's real DRIVE-phase appendEvent calls (module doc above)
  // — one "merged" per #110-sequence PR, all attributed to issue #110 (the umbrella issue every
  // one of these PRs closed a sub-task of).
  for (const pr of [112, 113, 114, 115, 116, 117]) {
    state.appendEvent("merged", { worker: "dry-run-seed", issue: 110, pr, headOid: "seed" });
  }
  // #111 is THIS round's own tracking issue (not actually gate②-escalated) — seeded as an
  // escalated issue anyway so the harness's "Escalated issues" section demonstrates real
  // comment/label fetching against a real issue, per the task's explicit round-window spec.
  state.appendEvent("drive-needs-human", {
    worker: "dry-run-seed", issue: 111, pr: 117,
    reason: "dry-run harness seed — #111 is this round's own tracking issue, included for the escalated-issues digest section",
  });
  state.appendEvent("plan-review-escalated", {
    round_id: round.round_id, issue: 110,
    reason: "dry-run harness seed — #110 is this round's parent/umbrella issue",
  });

  const started = Date.now();
  const digest = await buildRetroDigest({ forge, state }, round, cfg.roles.retro.digestMaxChars, RETRO_EVENT_KINDS);
  const elapsedMs = Date.now() - started;

  const truncated = digest.includes("digest truncated");
  process.stdout.write(digest + "\n");
  process.stderr.write(
    `\n--- dry-run stats ---\n` +
    `digest length: ${digest.length} chars (cap: ${cfg.roles.retro.digestMaxChars})\n` +
    `truncated: ${truncated}\n` +
    `assembly time: ${elapsedMs}ms\n`,
  );
  state.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
