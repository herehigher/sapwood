/**
 * Plain-language captions for the config drawer (frontend-design.md §3 E), grouped exactly as
 * the drawer groups them: Board · Lanes · Worker · Safety · Review & merge · Labels. Mirrors the
 * server's allowlist (`engine/src/state/read-model.ts`'s `CONFIG_ALLOWLIST`) rather than
 * importing it — that module pulls in engine/config internals this browser bundle must never
 * carry (the same reason `api/types.ts` mirrors the wire contract instead of importing it).
 * `config-captions.test.ts` is the drift guard between the two lists.
 */

const ROLE_KEYS = ["verificationPlanReviewer", "verificationPlanDrafter", "architect", "po", "harvest", "retro"] as const;

const ROLE_CAPTION: Record<(typeof ROLE_KEYS)[number], string> = {
  verificationPlanReviewer: "the pass that reviews an issue's verification plan",
  verificationPlanDrafter: "the pass that drafts an issue's verification plan",
  architect: "the architecture review pass",
  po: "the goal & align pass",
  harvest: "the round summary pass",
  retro: "the retro pass",
};

export interface ConfigKeyInfo {
  path: string;
  group: string;
  caption: string;
}

const BASE_KEYS: ConfigKeyInfo[] = [
  // Board
  { path: "board.owner", group: "Board", caption: "GitHub org or user that owns the tracked repo" },
  { path: "board.repo", group: "Board", caption: "The GitHub repo sapwood works against" },
  { path: "board.projectNumber", group: "Board", caption: "The ProjectV2 board number used as the work queue" },
  { path: "board.statusField", group: "Board", caption: "The board field used to track work state" },
  { path: "board.status.backlog", group: "Board", caption: 'The board column that means "not started yet"' },
  { path: "board.status.ready", group: "Board", caption: 'The board column that means "ready to dispatch"' },
  { path: "board.status.inProgress", group: "Board", caption: 'The board column that means "a lane is working on it"' },
  { path: "board.status.done", group: "Board", caption: 'The board column that means "merged and finished"' },
  // Lanes
  { path: "lanes.max", group: "Lanes", caption: "How many issues can be worked on at the same time" },
  { path: "lanes.roundDispatchCap", group: "Lanes", caption: "The most new issues one round will start" },
  { path: "lanes.reserveCap", group: "Lanes", caption: "How many lanes stay held back as reserve capacity" },
  { path: "lanes.prFixCap", group: "Lanes", caption: "How many fix rounds a PR gets before it's flagged for a human" },
  {
    path: "lanes.gatedReentryCap",
    group: "Lanes",
    caption: "How many times a blocked PR can be unblocked and re-tried before it's flagged for a human",
  },
  { path: "lanes.frictionMin", group: "Lanes", caption: "The minimum gap enforced between dispatching lanes" },
  // Worker
  { path: "worker.model", group: "Worker", caption: "The model a worker uses to write code" },
  { path: "worker.effort", group: "Worker", caption: "How much reasoning effort a worker spends per turn" },
  { path: "worker.timeoutSec", group: "Worker", caption: "How long a worker can run before it's stopped" },
  {
    path: "worker.budgetUsdSoft",
    group: "Worker",
    caption: "Budget per worker — reaching it asks the worker to wrap up and hand off, never kills it mid-work",
  },
  {
    path: "worker.maxResumes",
    group: "Worker",
    caption: "How many times a handed-off worker can be resumed before it's flagged for a human",
  },
  { path: "worker.heartbeatStaleSecs", group: "Worker", caption: "How long a worker can go quiet before it's considered stalled" },
  // Safety
  { path: "guard.mode", group: "Safety", caption: "How strictly the safety hook blocks a worker from merging or approving its own work" },
  { path: "cost.roundBudgetUsd", group: "Safety", caption: "Spending limit for a single round" },
  {
    path: "cost.dailyBudgetUsd",
    group: "Safety",
    caption: "Spending limit for the whole day — the engine stops dispatching new work once it's hit",
  },
  { path: "cost.maxWallClockSec", group: "Safety", caption: "How long a run can go before the wall-clock safety alarm fires" },
  { path: "cost.drainWindowSec", group: "Safety", caption: "How long a lane gets to finish or hand off before a stop is forced" },
  { path: "stop.afterIssuesMerged", group: "Safety", caption: "Stop the run automatically after this many issues merge" },
  { path: "stop.afterPRsOpened", group: "Safety", caption: "Stop the run automatically after this many PRs open" },
  { path: "stop.afterSpendUsd", group: "Safety", caption: "Stop the run automatically after this much is spent this run" },
  {
    path: "stop.onMilestoneComplete",
    group: "Safety",
    caption: "Stop the run automatically once the current milestone is complete",
  },
  // Review & merge
  { path: "reviewer.mode", group: "Review & merge", caption: "Which reviewer checks a PR before it can merge" },
  { path: "reviewer.triggerCommand", group: "Review & merge", caption: "The command used to trigger a review" },
  {
    path: "reviewer.deltaChainMax",
    group: "Review & merge",
    caption: "How many fix rounds a review chain can go before it's capped",
  },
  { path: "reviewer.agent.model", group: "Review & merge", caption: "The model the engine's own reviewer uses" },
  { path: "reviewer.agent.effort", group: "Review & merge", caption: "How much reasoning effort the engine's own reviewer spends" },
  { path: "merge.mode", group: "Review & merge", caption: "How an approved PR gets merged — automatically or left for a human" },
  // Labels
  { path: "labels.prefix", group: "Labels", caption: "The prefix applied to every label sapwood manages" },
  { path: "labels.inProgress", group: "Labels", caption: "The label marking an issue as actively being worked" },
  { path: "labels.needsHuman", group: "Labels", caption: "The label marking an issue or PR that needs a human decision" },
  { path: "labels.blocked", group: "Labels", caption: "The label marking an issue as blocked" },
  { path: "labels.reserve", group: "Labels", caption: "The label marking an issue held in reserve" },
  { path: "labels.verifyNa", group: "Labels", caption: "The label marking an issue as not separately verifiable" },
  { path: "labels.planApproved", group: "Labels", caption: "The label marking an issue's plan as approved and ready to dispatch" },
  { path: "labels.originAgent", group: "Labels", caption: "The label marking an issue that the loop created itself" },
  { path: "labels.split", group: "Labels", caption: "The label marking an issue that was split into smaller issues" },
  { path: "labels.decomposed", group: "Labels", caption: "The label marking an issue that has been decomposed into sub-issues" },
  { path: "labels.roundPool", group: "Labels", caption: "The label marking an issue selected into the current round's pool" },
];

const ROLE_ENTRIES: ConfigKeyInfo[] = ROLE_KEYS.flatMap((role) => [
  { path: `roles.${role}.model`, group: "Worker", caption: `The model used for ${ROLE_CAPTION[role]}` },
  { path: `roles.${role}.effort`, group: "Worker", caption: `The reasoning effort used for ${ROLE_CAPTION[role]}` },
]);

/** Group display order (§3 E) — the drawer renders empty groups too, so a group with nothing
 *  configured still shows its heading rather than silently vanishing. */
export const CONFIG_GROUPS = ["Board", "Lanes", "Worker", "Safety", "Review & merge", "Labels"] as const;

export const CONFIG_KEYS: ConfigKeyInfo[] = [...BASE_KEYS, ...ROLE_ENTRIES];

export function readConfigPath(config: Record<string, unknown>, path: string): unknown {
  let cur: unknown = config;
  for (const segment of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}
