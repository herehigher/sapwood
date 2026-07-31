// biome-ignore-all lint/suspicious/noTemplateCurlyInString: SITE_INVENTORY pins each site's SOURCE TEXT verbatim; a `${...}` inside one of those fixtures is the scanned file's template literal, not this file's.
// #397: the escalation action-bucket split — classifier behavior, the exhaustive write-site
// inventory, the new labels' provisioning/config wiring, and the doc pairing that keeps the
// shipped label text and docs/configuration.md from drifting apart again.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../config/config.js";
import { type ParsedProject, selectPlanReviewCandidates, selectPlanTriageCandidates, selectPoolEligibleIssues } from "../forge/forge.js";
import { isHumanMergeOnlyVerdict } from "./escalation-buckets.js";
import { requiredLabels } from "./init.js";

const cfg = parseConfig("board: { owner: acme, repo: widgets, projectNumber: 7 }");
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const REPO_ROOT = join(HERE, "..", "..", "..");

// ── the classifier ────────────────────────────────────────────────────────────────────────────

test("#397: isHumanMergeOnlyVerdict recognizes exactly the instruction-path (#292) verdicts, from both gate paths", () => {
  for (const reason of [
    "gate:HUMAN:instruction-path-latch",
    "gate:HUMAN:instruction-path-change:CLAUDE.md,.claude/rules/a.md",
    "gate:HUMAN:instruction-path-list-incomplete",
    "engine-agent: gate:HUMAN:instruction-path-latch",
    "engine-agent: gate:HUMAN:instruction-path-change:CLAUDE.md",
    "engine-agent: gate:HUMAN:instruction-path-list-incomplete",
  ]) {
    assert.equal(isHumanMergeOnlyVerdict(reason), true, reason);
  }
});

test("#397: every OTHER gate reason stays bucket 1 — the classifier is narrow on purpose, and cannot be forged from the reason's tail", () => {
  for (const reason of [
    "gate:HUMAN:MERGE_OK",
    "gate:HUMAN:WAIT_REVIEW",
    "gate:HUMAN:HANDLE_THREADS",
    "gate:HUMAN:merge-conflict",
    "gate:HUMAN:pr-state-CLOSED",
    "merge-decision:ESCALATE",
    "refuse-unpinned-merge-no-head-oid",
    "merge-conflict",
    "merge-failed-deterministic: boom",
    "driving-lane-missing-pr",
    "ac-snapshot-drift",
    // The matched-paths tail of a real bucket-2 reason is attacker-influenced (they are FILE
    // PATHS off the PR), and a nested reason wrapper concatenates one reason after another.
    // Neither may be able to mint a bucket-2 verdict out of a bucket-1 one.
    "gate:HUMAN:MERGE_OK:gate:HUMAN:instruction-path-change:x",
    "fix-loop-unwired:gate:HUMAN:instruction-path-latch",
    "gate:HUMAN:instruction-path-change:CLAUDE.md".replace(/^/, "unrelated-prefix "),
  ]) {
    assert.equal(isHumanMergeOnlyVerdict(reason), false, reason);
  }
});

// ── the exhaustive write-site inventory (AC: "fails if a site is missing from the table") ─────

/**
 * #397 AC: every escalation site is assigned to EXACTLY ONE bucket, quantified over WRITE SITES
 * rather than a `gate:HUMAN:*` reason prefix (several sites carry non-gate-prefixed reasons, or
 * none at all). Two mechanically-scannable site kinds:
 *
 *   LABEL — an `addLabel`/`addPRLabel` call naming `needsHuman`/`humanMergeOnly`/`planless`.
 *   GATE  — a `needs-human` DriveOutcome literal produced by one of the two gate paths
 *           (`roles/merge-driver.ts`, `review/drive.ts`). A pure RELAY that forwards another
 *           site's `outcome.reason` is deliberately out of scope: it takes no classification
 *           decision of its own, it carries the delegated site's bucket unchanged.
 *
 * Keys are `${file}#${ordinal-within-file}` and each row pins the source text, so MOVING a site
 * is free while ADDING, REMOVING, or REWRITING one fails this test until it is classified.
 */
const SITE_INVENTORY: Record<string, { bucket: "human-merge-only" | "needs-human" | "planless"; src: string; why: string }> = {
  // ── bucket 2: a human must MERGE this PR ────────────────────────────────────────────────
  "review/instruction-path-escalation.ts#0": {
    bucket: "human-merge-only",
    src: "await input.forge.addPRLabel(input.pr, input.cfg.labels.humanMergeOnly);",
    why: "#292 instruction-path trust chain — the PR is fine, its merge decision is a human's",
  },
  "roles/merge-driver.ts#0": {
    bucket: "human-merge-only",
    src: 'return observed({ kind: "needs-human", pr, reason: "gate:HUMAN:instruction-path-latch" });',
    why: "classic path, latched",
  },
  "roles/merge-driver.ts#1": {
    bucket: "human-merge-only",
    src: 'kind: "needs-human",',
    why: "classic path, freshly escalated (change / list-incomplete)",
  },
  "review/drive.ts#1": {
    bucket: "human-merge-only",
    src: 'return { kind: "needs-human", reason: "engine-agent: gate:HUMAN:instruction-path-latch" };',
    why: "engine-agent path, latched",
  },
  "review/drive.ts#2": { bucket: "human-merge-only", src: 'kind: "needs-human",', why: "engine-agent path, freshly escalated" },

  // ── not an escalation at all: the class-6 routing fence ─────────────────────────────────
  "loop/decompose.ts#2": {
    bucket: "planless",
    src: 'if (child.kind === "remainder") await deps.forge.addLabel(issue, deps.cfg.labels.planless);',
    why: "decompose remainder — a fence keeping a plan-less child off every queue, nobody owes a decision",
  },
  "loop/align.ts#0": {
    bucket: "planless",
    src: "if (!hasPlan) await deps.forge.addLabel(issueNumber, l.planless);",
    why: "PO-created issue with no verification plan — same fence, same non-escalation",
  },

  // ── bucket 1: the machine stopped; a human owes the next decision ───────────────────────
  // 1a — cap / DEAD / undecidable lane disposition (conductor).
  "loop/conductor.ts#0": {
    bucket: "needs-human",
    src: "await forge.addLabel(row.issue, cfg.labels.needsHuman).catch(() => {});",
    why: "rollback exhausted (reasonless escalation)",
  },
  "loop/conductor.ts#1": {
    bucket: "needs-human",
    src: "await forge.addLabel(worker.issue, cfg.labels.needsHuman);",
    why: "resume cap reached",
  },
  "loop/conductor.ts#2": {
    bucket: "needs-human",
    src: "await forge.addLabel(w.issue, cfg.labels.needsHuman).catch(() => {});",
    why: "drain escalation (issue)",
  },
  "loop/conductor.ts#3": {
    bucket: "needs-human",
    src: "await forge.addPRLabel(p.prNumber, cfg.labels.needsHuman).catch(() => {});",
    why: "drain escalation (PR)",
  },
  "loop/conductor.ts#4": {
    bucket: "needs-human",
    src: "await forge.addLabel(w.issue, cfg.labels.needsHuman);",
    why: "drain of a driving lane",
  },
  "loop/conductor.ts#5": {
    bucket: "needs-human",
    src: "await forge.addLabel(w.issue, cfg.labels.needsHuman);",
    why: "handoff cap reached",
  },
  "loop/conductor.ts#6": {
    bucket: "needs-human",
    src: "await forge.addLabel(w.issue, cfg.labels.needsHuman);",
    why: "dead lane with retained dirty worktree (issue)",
  },
  "loop/conductor.ts#7": {
    bucket: "needs-human",
    src: "if (p.prNumber != null) await forge.addPRLabel(p.prNumber, cfg.labels.needsHuman);",
    why: "same, on the PR",
  },
  "loop/conductor.ts#8": { bucket: "needs-human", src: "await forge.addLabel(w.issue, cfg.labels.needsHuman);", why: "reclaim escalation" },
  "loop/conductor.ts#9": {
    bucket: "needs-human",
    src: "await forge.addLabel(w.issue, cfg.labels.needsHuman);",
    why: "escalateNeedsHuman — the shared gate-verdict escalation",
  },
  "loop/conductor.ts#10": {
    bucket: "needs-human",
    src: "await forge.addLabel(w.issue, cfg.labels.needsHuman);",
    why: "#283 AC-snapshot drift — unverifiable lane",
  },
  "loop/conductor.ts#11": {
    bucket: "needs-human",
    src: "await forge.addLabel(w.issue, cfg.labels.needsHuman);",
    why: "dead lane, dirty worktree (issue)",
  },
  "loop/conductor.ts#12": {
    bucket: "needs-human",
    src: "if (p.prNumber != null) await forge.addPRLabel(p.prNumber, cfg.labels.needsHuman);",
    why: "same, on the PR",
  },
  "loop/conductor.ts#13": {
    bucket: "needs-human",
    src: "await forge.addLabel(w.issue, cfg.labels.needsHuman);",
    why: "dead fixing lane, dirty worktree (issue)",
  },
  "loop/conductor.ts#14": {
    bucket: "needs-human",
    src: "if (p.prNumber != null) await forge.addPRLabel(p.prNumber, cfg.labels.needsHuman);",
    why: "same, on the PR",
  },
  "loop/conductor.ts#15": {
    bucket: "needs-human",
    src: "await forge.addLabel(w.issue, cfg.labels.needsHuman);",
    why: "fail-safe: dead fixing lane with no PR",
  },
  "loop/conductor.ts#16": {
    bucket: "needs-human",
    src: "await forge.addLabel(w.issue, cfg.labels.needsHuman);",
    why: "#147 gated-reentry CAPPED — re-applies the label it must never be able to re-apply for bucket 2",
  },
  "loop/conductor.ts#17": {
    bucket: "needs-human",
    src: "await forge.addLabel(w.issue, cfg.labels.needsHuman);",
    why: "fail-safe: driving lane missing its PR",
  },
  "loop/conductor.ts#18": {
    bucket: "needs-human",
    src: "await forge.addPRLabel(pr, cfg.labels.needsHuman);",
    why: "#170 review-silence visibility escalation (PR)",
  },
  "loop/conductor.ts#19": {
    bucket: "needs-human",
    src: "await forge.addLabel(w.issue, cfg.labels.needsHuman);",
    why: "fix-leg start failure",
  },
  "loop/conductor.ts#20": {
    bucket: "needs-human",
    src: "await forge.addLabel(w.issue, cfg.labels.needsHuman);",
    why: "ceiling/wind-down terminal escalation",
  },
  "loop/conductor.ts#21": {
    bucket: "needs-human",
    src: "await forge.addLabel(w.issue, cfg.labels.needsHuman).catch(() => {});",
    why: "kill-switch drain escalation",
  },
  // 1b — the PO decomposition path's genuine give-ups (distinct from the class-6 fence above).
  "loop/decompose.ts#0": {
    bucket: "needs-human",
    src: "await deps.forge.addLabel(parent.number, deps.cfg.labels.needsHuman);",
    why: "fenced title collision — human reconciliation required",
  },
  "loop/decompose.ts#1": {
    bucket: "needs-human",
    src: "await deps.forge.addLabel(parent.number, deps.cfg.labels.needsHuman);",
    why: "created-receipt/live mismatch — human reconciliation required",
  },
  "loop/decompose.ts#3": {
    bucket: "needs-human",
    src: "await deps.forge.addLabel(parent.number, deps.cfg.labels.needsHuman);",
    why: "decomposition session invalid after retry",
  },
  "loop/decompose.ts#4": {
    bucket: "needs-human",
    src: "await deps.forge.addLabel(parent.number, deps.cfg.labels.needsHuman);",
    why: "unresolved decision failed to persist",
  },
  "loop/decompose.ts#5": {
    bucket: "needs-human",
    src: "await deps.forge.addLabel(parent.number, deps.cfg.labels.needsHuman);",
    why: "preflight title collision, zero children",
  },
  "loop/decompose.ts#6": {
    bucket: "needs-human",
    src: "await deps.forge.addLabel(parent.number, deps.cfg.labels.needsHuman);",
    why: "proposal evidence failed to persist",
  },
  // 1c — peripheral role-session failure and the verify:n/a doc-gate signoff.
  "roles/plan-review.ts#0": {
    bucket: "needs-human",
    src: "await deps.forge.addLabel(issue.number, l.needsHuman);",
    why: "plan-review session failed/degraded",
  },
  "roles/plan-review.ts#1": {
    bucket: "needs-human",
    src: "await deps.forge.addLabel(issue.number, l.needsHuman);",
    why: "verify:n/a doc-gate — removal IS the human signoff",
  },
  // 1d — the architect's batch-review POOL VERDICT: agent-adjudicated "a human should look at
  // this work item". A seventh, distinct meaning, classified as its own bucket-1 sub-case (still
  // the #147 handshake on removal) rather than folded into "the machine gave up".
  "roles/architect.ts#0": {
    bucket: "needs-human",
    src: "await deps.forge.addLabel(v.issue, deps.cfg.labels.needsHuman);",
    why: "architect pool verdict (bucket-1 sub-case)",
  },
  // 1e — the fix-response thread-write escalation.
  "loop/fix-response.ts#0": {
    bucket: "needs-human",
    src: "await forge.addLabel(row.issue, cfg.labels.needsHuman);",
    why: "thread-write retries exhausted (issue)",
  },
  "loop/fix-response.ts#1": {
    bucket: "needs-human",
    src: "await forge.addPRLabel(row.pr, cfg.labels.needsHuman);",
    why: "same, on the PR",
  },
  // 1g — #432 round 5: the two retry-cap degrade-to-human escalations the F32 saga's own
  // design rule produced (probeHasWork's "every signal must name its terminal" — see round.ts's
  // doc). Same bounded-retry-then-degrade paradigm as maxDraftCycles/prFixCap, both new this round.
  "loop/dissent.ts#0": {
    bucket: "needs-human",
    src: "await forge.addLabel(concern.issue, cfg.labels.needsHuman);",
    why: "a durable dissent concern failed to post maxConcernPostAttempts times (unreadable/inaccessible issue)",
  },
  "loop/round.ts#0": {
    bucket: "needs-human",
    src: "await forge.addLabel(issue, cfg.labels.needsHuman);",
    why: "a stale roundPool label failed to remove maxPoolRemovalAttempts times",
  },
  // 1f — gate verdicts that mean "the machine is stuck", INCLUDING the three non-gate-prefixed
  // merge-driver reasons the AC calls out by name.
  "roles/merge-driver.ts#2": {
    bucket: "needs-human",
    src: 'if (conflictGate === "HUMAN") return observed({ kind: "needs-human", pr, reason: "gate:HUMAN:merge-conflict" });',
    why: "conflict, fix loop disabled",
  },
  "roles/merge-driver.ts#3": {
    bucket: "needs-human",
    src: 'if (gate === "HUMAN") return { kind: "needs-human", pr, reason: `gate:${gate}:${verdict.action}` };',
    why: "deriveGate HUMAN (human label, draft, non-OPEN, findings with no fix loop)",
  },
  "roles/merge-driver.ts#4": {
    bucket: "needs-human",
    src: 'if (decision === "ESCALATE") return { kind: "needs-human", pr, reason: `merge-decision:${decision}` };',
    why: "merge-decision:ESCALATE (no gate: prefix)",
  },
  "roles/merge-driver.ts#5": {
    bucket: "needs-human",
    src: 'return { kind: "needs-human", pr, reason: "refuse-unpinned-merge-no-head-oid" };',
    why: "refuse-unpinned-merge (no gate: prefix)",
  },
  "roles/merge-driver.ts#6": {
    bucket: "needs-human",
    src: 'return { kind: "needs-human", pr, reason: "merge-conflict" };',
    why: "merge-conflict at the merge point (no gate: prefix)",
  },
  "roles/merge-driver.ts#7": {
    bucket: "needs-human",
    src: 'return { kind: "needs-human", pr, reason: `merge-failed-deterministic: ${msg}` };',
    why: "deterministic merge failure",
  },
  "roles/merge-driver.ts#8": {
    bucket: "needs-human",
    src: 'if (conflictGate === "HUMAN") return { kind: "needs-human", pr, reason: "gate:HUMAN:merge-conflict" };',
    why: "#460: the engine-agent route's own CONFLICTING block (driveEngineAgentOne) — same reason as #2, fix loop disabled",
  },
  "review/drive.ts#0": {
    bucket: "needs-human",
    src: 'return { kind: "needs-human", reason: `engine-agent: gate:HUMAN:pr-state-${data0.state}` };',
    why: "engine-agent: PR no longer OPEN",
  },
};

function engineSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) engineSourceFiles(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.includes("test-support")) out.push(path);
  }
  return out;
}

/** Scan engine source for the two site kinds above, in a stable (file, ordinal) order. */
function scanEscalationSites(): Array<{ key: string; src: string }> {
  const found: Array<{ key: string; src: string }> = [];
  for (const file of engineSourceFiles(SRC).sort()) {
    const rel = relative(SRC, file).split("\\").join("/");
    const lines = readFileSync(file, "utf8").split("\n");
    let labelOrdinal = 0;
    for (const line of lines) {
      if (/\b(?:addLabel|addPRLabel)\(/.test(line) && /\.(?:needsHuman|humanMergeOnly|planless)\b/.test(line)) {
        found.push({ key: `${rel}#${labelOrdinal++}`, src: line.trim() });
      }
    }
    if (rel !== "roles/merge-driver.ts" && rel !== "review/drive.ts") continue;
    let gateOrdinal = 0;
    for (const line of lines) {
      // `reason: string` is the union DECLARATION; `outcome.reason` is a pure relay (see the
      // inventory's doc comment) — neither is a classification site.
      if (line.includes('kind: "needs-human"') && !line.includes("reason: string") && !line.includes("outcome.reason")) {
        found.push({ key: `${rel}#${gateOrdinal++}`, src: line.trim() });
      }
    }
  }
  return found;
}

test("#397 AC: EVERY escalation write site in engine source is classified into exactly one bucket — an unclassified site fails this test", () => {
  const sites = scanEscalationSites();
  const unclassified = sites.filter((s) => SITE_INVENTORY[s.key] === undefined);
  assert.deepEqual(
    unclassified,
    [],
    `new/renumbered escalation site(s) — classify each into human-merge-only / needs-human / planless in SITE_INVENTORY:\n` +
      unclassified.map((s) => `  ${s.key}  ${s.src}`).join("\n"),
  );
  const stale = Object.keys(SITE_INVENTORY).filter((key) => !sites.some((s) => s.key === key));
  assert.deepEqual(stale, [], "SITE_INVENTORY row(s) whose site no longer exists — delete them");
  for (const site of sites) {
    assert.equal(SITE_INVENTORY[site.key]?.src, site.src, `site ${site.key} was rewritten — re-check its bucket`);
  }
});

test("#397 AC: the corrected site inventory — 7 PR-side label writes, 31 issue-side (#432 round 5 added 2), and the non-gate-prefixed merge-driver/rollback sites are all present", () => {
  const sites = scanEscalationSites();
  const labelSites = sites.filter(
    (s) => SITE_INVENTORY[s.key]!.src.includes("addLabel(") || SITE_INVENTORY[s.key]!.src.includes("addPRLabel("),
  );
  const prSide = labelSites.filter((s) => s.src.includes("addPRLabel("));
  assert.equal(prSide.length, 7, "PR-side escalation writes (#397's corrected count)");
  assert.equal(
    labelSites.length - prSide.length,
    31,
    "issue-side escalation writes (#397's corrected count + #432 round 5's dissent/round-pool retry-cap escalations)",
  );
  // The four sites the AC names explicitly because they carry no `gate:HUMAN:` reason prefix.
  for (const key of ["roles/merge-driver.ts#4", "roles/merge-driver.ts#5", "roles/merge-driver.ts#6", "loop/conductor.ts#0"]) {
    assert.equal(SITE_INVENTORY[key]?.bucket, "needs-human", key);
  }
  // Exactly one site writes the bucket-2 label, and it is the instruction-path path.
  const bucket2Writes = labelSites.filter((s) => s.src.includes("humanMergeOnly"));
  assert.deepEqual(
    bucket2Writes.map((s) => s.key),
    ["review/instruction-path-escalation.ts#0"],
  );
});

// ── the new labels: provisioning, descriptions, config wiring ─────────────────────────────────

test("#397: requiredLabels provisions both new labels", () => {
  const names = requiredLabels(cfg).map((l) => l.name);
  assert.ok(names.includes("sapwood:human-merge-only"));
  assert.ok(names.includes("sapwood:planless"));
});

test("#397 AC: every escalation-tier label description states writer / required action / removal effect, fits GitHub's 100-char cap, and is quoted VERBATIM in docs/configuration.md", () => {
  const doc = readFileSync(join(REPO_ROOT, "docs", "configuration.md"), "utf8");
  const tier: Array<[string, RegExp]> = [
    // [label, a pattern proving the description names WHO writes it]
    ["sapwood:needs-human", /engine-applied/i],
    ["sapwood:blocked", /applied/i],
    ["sapwood:reserve", /applied/i],
    ["sapwood:hold", /human is reviewing/i],
    ["sapwood:human-merge-only", /engine-applied/i],
    ["sapwood:planless", /engine-applied/i],
  ];
  for (const [name, writer] of tier) {
    const spec = requiredLabels(cfg).find((l) => l.name === name);
    assert.ok(spec, `${name} must be provisioned`);
    assert.ok(spec.description.length <= 100, `${name}: GitHub caps descriptions at 100 chars (got ${spec.description.length})`);
    assert.match(spec.description, writer, `${name}: description must say who writes it`);
    // What removing it does — or, for the one-way verdict, that removing it is not a thing.
    assert.match(spec.description, /remove|never removes/i, `${name}: description must say what removal does`);
    assert.ok(
      doc.includes(spec.description),
      `docs/configuration.md must quote ${name}'s shipped description verbatim: ${spec.description}`,
    );
  }
});

test("#397 P1: human-merge-only is a PROTECTED label (collision-guarded) but is NEVER a member of escalation.humanLabels", () => {
  // Asserted against the array's actual contents, not a predicate — wiring it in "to get the
  // gate veto for free" is the reclaim-loop bug this issue exists to avoid.
  assert.deepEqual(cfg.escalation.humanLabels, ["sapwood:needs-human", "sapwood:blocked"]);
  assert.equal(cfg.labels.humanMergeOnly, "sapwood:human-merge-only");
  assert.equal(cfg.labels.planless, "sapwood:planless");
  // ...but the collision guard DOES protect both, exactly like every other requiredLabels entry.
  for (const [key, value] of [
    ["roundPool", "sapwood:human-merge-only"],
    ["roundPool", "sapwood:planless"],
  ] as Array<[string, string]>) {
    assert.throws(
      () => parseConfig(`board: { owner: a, repo: b, projectNumber: 1 }\nlabels: { ${key}: "${value}" }`),
      /collides with/,
      `${key} aliasing ${value} must be rejected at config load`,
    );
  }
  assert.throws(
    () => parseConfig('board: { owner: a, repo: b, projectNumber: 1 }\nlabels: { planless: "sapwood:human-merge-only" }'),
    /collides with/,
    "the two new labels must not alias each other",
  );
  assert.throws(
    () => parseConfig('board: { owner: a, repo: b, projectNumber: 1 }\nlabels: { humanMergeOnly: "sapwood:needs-human" }'),
    /collides with/,
    "bucket 2 must not alias bucket 1",
  );
  assert.throws(
    () => parseConfig('board: { owner: a, repo: b, projectNumber: 1 }\nescalation: { holdLabels: ["sapwood:planless"] }'),
    /collides with/,
    "a hold label must not alias the planless fence",
  );
});

// ── the fence keeps the exact exposure `needs-human` gave it ───────────────────────────────────

/** One Ready-lane board item carrying `labels`, wrapped in the minimal ParsedProject the three
 *  selectors read (they only ever touch `items`). */
const project = (labels: string[]): ParsedProject => ({
  projectId: "P",
  statusFieldId: "F",
  options: [],
  placements: [],
  items: [boardItem(labels)],
});

const boardItem = (labels: string[]) => ({
  itemId: "PVTI_1",
  number: 1,
  title: "t",
  labels,
  body: "no plan here",
  repo: "acme/widgets",
  state: "OPEN" as const,
  status: "Ready",
  milestone: null,
});

test("#397 AC: an issue carrying ONLY sapwood:planless is excluded by isPoolEligible / needsPlanReview / needsPlanTriage, exactly as a needs-human one is", () => {
  const readyCfg = { board: cfg.board, labels: cfg.labels };
  for (const [name, select] of [
    ["pool", selectPoolEligibleIssues],
    ["plan-review", selectPlanReviewCandidates],
    ["plan-triage", selectPlanTriageCandidates],
  ] as Array<[string, typeof selectPoolEligibleIssues]>) {
    // Control: a bare issue IS a candidate for each of the three, so the exclusions below are
    // proving something.
    assert.equal(select(project([]), readyCfg).length, 1, `${name}: bare issue is a candidate`);
    assert.equal(select(project(["sapwood:needs-human"]), readyCfg).length, 0, `${name}: needs-human excluded`);
    assert.equal(select(project(["sapwood:planless"]), readyCfg).length, 0, `${name}: planless excluded`);
  }
});

// ── docs: the `blocked` writer contradiction (#397 item 4) ────────────────────────────────────

test("#397 item 4: docs/PLAN.md's three-tier table and its write-side-asymmetry paragraph agree that `blocked` is ENGINE-applied", () => {
  const plan = readFileSync(join(REPO_ROOT, "docs", "PLAN.md"), "utf8");
  const tierRow = plan.split("\n").find((l) => /^\s*\|\s*`blocked`\s*\|/.test(l));
  assert.ok(tierRow, "the three-tier table must still carry a `blocked` row");
  // Column 2 is "written by". The code (roles/architect.ts, severe contradiction) writes it, so
  // the table may no longer claim it is human-only.
  const writtenBy = tierRow.split("|")[2]?.trim() ?? "";
  assert.match(writtenBy, /engine/i, "the tier table's `blocked` writer column must name the engine");
  // The asymmetry paragraph says the same thing, and the two must not disagree.
  assert.match(plan, /only\s+`needsHuman`\/`blocked` are ever engine-applied/);
});
