import { useEffect, useRef } from "react";
import { readConfigPath } from "../config-captions.ts";
import type { EntityTitles } from "../entities.ts";
import { modelEffortCaption } from "../hero/stage.tsx";
import {
  countEventKind,
  NODE_PHASE,
  PHASE_HEADING,
  readAlign,
  readDegradedPhases,
  readLanesCounters,
  readRetro,
  readSummary,
  type StageNode,
} from "../inspector.ts";
import { EntityRef } from "./EntityRef.tsx";

export interface PhaseInspectorDrawerProps {
  /** The stage node that opened this drawer; `null` closes it (same posture as `ConfigDrawer`'s
   *  `open` boolean, but a node identity is needed too — AC3's caption varies per node even
   *  though several nodes share one drawer phase). */
  node: StageNode | null;
  onClose: () => void;
  /** The bound round's own artifact (§6 mode-purity: the live open round, or the replay cursor's
   *  round) — `null`/malformed degrades to an honest "not recorded" per field (AC6), never a
   *  throw. */
  artifact: unknown;
  /** The same fold `ActivityFeed`/`NeedsAttention` already render — source for the Arch
   *  review/Verify drawer's event-derived counts (AC2). */
  events: readonly { kind: string }[];
  config: Record<string, unknown> | null;
  /** `/api/loop/state`'s `logPath`, already resolved live-only by the caller (AC5) — `null`
   *  hides the "view log" row entirely (unknown, or a replayed/closed round). */
  logPath: string | null;
  repoUrl?: string | undefined;
  titles: EntityTitles;
}

const NOT_RECORDED = "not recorded";

function Counter({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="config-drawer-row">
      <dt className="data">{label}</dt>
      <dd className="data">{value === null ? NOT_RECORDED : value}</dd>
    </div>
  );
}

function GoalAlignBody({ artifact, repoUrl, titles }: { artifact: unknown; repoUrl?: string | undefined; titles: EntityTitles }) {
  const { created, triaged } = readAlign(artifact);
  return (
    <>
      <div className="config-drawer-group">
        <h3 className="muted">created issues</h3>
        {created === null ? (
          <p className="muted">{NOT_RECORDED}</p>
        ) : created.length === 0 ? (
          <p className="muted">none this round</p>
        ) : (
          <ul>
            {created.map((c) => (
              <li key={c.issue}>
                <EntityRef token={{ kind: "issue", number: c.issue }} titles={titles} repoUrl={repoUrl} /> {c.title}
                {c.hasPlan ? "" : " (no plan yet)"}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="config-drawer-group">
        <h3 className="muted">triaged issues</h3>
        {triaged === null ? (
          <p className="muted">{NOT_RECORDED}</p>
        ) : triaged.length === 0 ? (
          <p className="muted">none this round</p>
        ) : (
          <ul>
            {triaged.map((t) => (
              <li key={t.issue}>
                <EntityRef token={{ kind: "issue", number: t.issue }} titles={titles} repoUrl={repoUrl} />{" "}
                {t.drafted ? "plan drafted" : "still planless"}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function ArchVerifyBody({ artifact, events }: { artifact: unknown; events: readonly { kind: string }[] }) {
  const degraded = readDegradedPhases(artifact, ["architect", "plan_review"]);
  return (
    <>
      <div className="config-drawer-group">
        <h3 className="muted">degraded sessions</h3>
        {degraded === null ? (
          <p className="muted">{NOT_RECORDED}</p>
        ) : degraded.length === 0 ? (
          <p className="muted">none this round</p>
        ) : (
          <ul>
            {degraded.map((d) => (
              <li key={`${d.phase}-${d.session}`}>
                {d.phase}: {d.outcome} (session {d.session})
              </li>
            ))}
          </ul>
        )}
      </div>
      <dl className="config-drawer-group">
        <Counter label="plan-review escalations" value={countEventKind(events, "plan-review-escalated")} />
        {/* #893: was "no-plan-after-draft" — a dashboard-only kind the engine never actually
         *  registers (dead cross-package drift closed by this PR); swapped for a real,
         *  distinct plan-review-family kind so this counter is never permanently zero. */}
        <Counter label="verify n/a proposed" value={countEventKind(events, "verify-na-proposed")} />
      </dl>
    </>
  );
}

function LanesBody({ artifact }: { artifact: unknown }) {
  const c = readLanesCounters(artifact);
  return (
    <dl className="config-drawer-group">
      <Counter label="dispatches" value={c.dispatches} />
      <Counter label="merges" value={c.merges} />
      <Counter label="handoffs" value={c.handoffs} />
      <Counter label="gated reentries" value={c.retries?.gatedReentries ?? null} />
      <Counter label="gated reentries capped" value={c.retries?.gatedReentryCapped ?? null} />
      <Counter label="rollbacks recovered" value={c.retries?.rollbacksRecovered ?? null} />
      <Counter label="rollbacks escalated" value={c.retries?.rollbacksEscalated ?? null} />
      <Counter label="needs-human escalations" value={c.escalations?.needsHuman ?? null} />
      <Counter label="ceiling escalations" value={c.escalations?.ceiling ?? null} />
      <Counter label="drive-no-pr" value={c.escalations?.driveNoPr ?? null} />
    </dl>
  );
}

function SummaryBody({ artifact }: { artifact: unknown }) {
  const s = readSummary(artifact);
  const spend =
    s.spendUsd === null || s.roundBudgetUsd === null ? NOT_RECORDED : `$${s.spendUsd.toFixed(2)} of $${s.roundBudgetUsd.toFixed(2)}`;
  return (
    <dl className="config-drawer-group">
      <div className="config-drawer-row">
        <dt className="data">spend</dt>
        <dd className="data">{spend}</dd>
      </div>
      <Counter label="PRs opened" value={s.prsOpened} />
      <Counter label="PRs merged" value={s.prsMerged} />
      <Counter label="issues closed" value={s.issuesClosed} />
    </dl>
  );
}

function RetroBody({ artifact, repoUrl }: { artifact: unknown; repoUrl?: string | undefined }) {
  const r = readRetro(artifact);
  if (!r.known) return <p className="muted">{NOT_RECORDED}</p>;
  if (r.opened) {
    return (
      <p>
        <EntityRef token={{ kind: "pr", number: r.opened.pr }} titles={{}} repoUrl={repoUrl} /> opened on {r.opened.branch}
      </p>
    );
  }
  if (r.degraded) {
    return (
      <p className="muted">
        degraded: {r.degraded.reason} (branch {r.degraded.branch})
      </p>
    );
  }
  return <p className="muted">no proposal this round</p>;
}

/**
 * §6's phase inspector — a read-only side drawer, same structural-read-only posture as
 * `ConfigDrawer` (no input/button/form other than close). `node` decides both which of the five
 * §6 phases renders (`NODE_PHASE`) and which caption shows (AC3): CI/merge show none, REVIEW
 * shows the review mode word, every other node shows its configured model·effort.
 *
 * #892 (#876 C-2 ruling): a native `<dialog>` via `.showModal()` — this drops the hand-rolled
 * `document`-level Escape listener entirely; `showModal()`'s own native Escape→`cancel`→`close`
 * sequence covers it now (wired to `onClose` below), same as `ConfigDrawer`.
 */
export function PhaseInspectorDrawer({ node, onClose, artifact, events, config, logPath, repoUrl, titles }: PhaseInspectorDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `node` isn't read in the body, but it's the trigger for re-running showModal() each time the dialog element gets freshly mounted (node flips null -> non-null unmounts then remounts it).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, [node]);

  if (!node) return null;

  const phase = NODE_PHASE[node];
  const caption = captionForNode(node, config);

  return (
    <dialog ref={dialogRef} className="panel config-drawer phase-inspector recipe-drawer" aria-label="phase inspector" onClose={onClose}>
      <div className="config-drawer-head">
        <h2>{PHASE_HEADING[phase]}</h2>
        <button type="button" onClick={onClose} className="config-drawer-close recipe-press" aria-label="close phase inspector">
          ✕
        </button>
      </div>
      {caption !== null && <p className="muted data">{caption}</p>}
      {phase === "goal-align" && <GoalAlignBody artifact={artifact} repoUrl={repoUrl} titles={titles} />}
      {phase === "arch-verify" && <ArchVerifyBody artifact={artifact} events={events} />}
      {phase === "lanes" && <LanesBody artifact={artifact} />}
      {phase === "summary" && <SummaryBody artifact={artifact} />}
      {phase === "retro" && <RetroBody artifact={artifact} repoUrl={repoUrl} />}
      {logPath !== null && <p className="muted data">view log: {logPath}</p>}
    </dialog>
  );
}

/** `config-captions.ts`'s `roles.<role>` path for each LLM-backed node (§3 C) — mirrors
 *  `stage.tsx`'s own `PLANNING_NODES`/`REFLECTION_NODES` role assignments exactly, so the same
 *  config path that lights a node's caption on the stage lights it again in its drawer. */
const ROLE_PATH: Record<"goal-align" | "arch-review" | "verify" | "summary" | "retro", string> = {
  "goal-align": "roles.po",
  "arch-review": "roles.architect",
  verify: "roles.verificationPlanReviewer",
  summary: "roles.harvest",
  retro: "roles.retro",
};

/** AC3: every drawer shows the node's configured model·effort caption, EXCEPT gate ② (REVIEW,
 *  which shows the review *mode* word instead) and CI/the merge arm (not model-backed — no
 *  caption at all, not even an honest-unknown placeholder). */
function captionForNode(node: StageNode, config: Record<string, unknown> | null): string | null {
  switch (node) {
    case "ci":
    case "merge":
      return null;
    case "review": {
      const reviewMode = config ? readConfigPath(config, "reviewer.mode") : undefined;
      return typeof reviewMode === "string" ? reviewMode : null;
    }
    case "lane":
      return modelEffortCaption(config, "worker");
    default:
      return modelEffortCaption(config, ROLE_PATH[node]);
  }
}
