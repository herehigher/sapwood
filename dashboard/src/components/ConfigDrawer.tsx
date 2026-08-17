import { useEffect, useRef } from "react";
import { isDistStale, shortSha } from "../build-info.ts";
import { CONFIG_GROUPS, CONFIG_KEYS, readConfigPath } from "../config-captions.ts";
import { formatAbsoluteTime } from "../format-time.ts";

export interface ConfigDrawerProps {
  /** `null` when the config is unreadable (§3's documented empty state) — server-served, never
   *  the whole resolved config (the allowlist is the no-secrets guarantee, §3 E). */
  config: Record<string, unknown> | null;
  open: boolean;
  onClose?: () => void;
  /** #894: this bundle's own build identity (`build-info.ts`, embedded at build time) — `null`
   *  under a harness that never ran the real vite build. */
  buildSha?: string | null;
  buildTime?: string | null;
  /** #894: the server's live dist-vs-repo-HEAD comparison facts (`/api/loop/state`'s `build`
   *  field) — `null` until a poll has landed, or when the server itself can't determine one side
   *  (no dist build yet, or its repo dir isn't a git checkout). */
  distSha?: string | null;
  repoHeadSha?: string | null;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** Read-only, grouped, captioned (§3 E) — and structurally read-only: there is no input, no
 *  button, no form anywhere in this component, so "no edit affordance" is a fact about what does
 *  not exist here, not an unimplemented handler.
 *
 *  #892 (#876 C-2 ruling): a native `<dialog>`, opened via `.showModal()` — focus trap, Escape,
 *  and backdrop all come from the browser, not hand-rolled. The `open` prop still fully owns
 *  mount/unmount (same contract as before: closed renders nothing at all); the effect below only
 *  drives the ALREADY-MOUNTED element's modal state. */
export function ConfigDrawer({
  config,
  open,
  onClose,
  buildSha = null,
  buildTime = null,
  distSha = null,
  repoHeadSha = null,
}: ConfigDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `open` isn't read in the body, but it's the trigger for re-running showModal() each time the dialog element gets freshly mounted (open flips false -> true unmounts then remounts it).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, [open]);

  if (!open) return null;
  const stale = isDistStale(distSha, repoHeadSha);
  return (
    <dialog ref={dialogRef} className="panel config-drawer recipe-drawer" aria-label="config" onClose={onClose}>
      <div className="config-drawer-head">
        <h2>config</h2>
        {onClose && (
          <button type="button" onClick={onClose} className="config-drawer-close recipe-press" aria-label="close config">
            ✕
          </button>
        )}
      </div>
      {config === null ? (
        <p className="muted">config unreadable</p>
      ) : (
        CONFIG_GROUPS.map((group) => {
          const keys = CONFIG_KEYS.filter((k) => k.group === group);
          const rows = keys.map((k) => ({ ...k, value: readConfigPath(config, k.path) })).filter((row) => row.value !== undefined);
          return (
            <div key={group} className="config-drawer-group">
              <h3 className="muted">{group}</h3>
              {rows.length === 0 ? (
                <p className="muted">nothing configured here</p>
              ) : (
                <dl>
                  {rows.map((row) => (
                    <div key={row.path} className="config-drawer-row">
                      <dt className="data">{row.path}</dt>
                      <dd className="data">{formatValue(row.value)}</dd>
                      <dd className="muted config-drawer-caption">{row.caption}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          );
        })
      )}
      {/* #894: quiet, token-language build identity — never chrome. Always renders (a stale
       *  bundle needs an on-screen tell); the stale-dist chip only joins it once the server has
       *  actually evidenced a divergence between what it serves and the repo HEAD it serves from. */}
      <div className="config-drawer-footer muted">
        <span className="data config-drawer-build">
          build {shortSha(buildSha)} · {buildTime ? formatAbsoluteTime(buildTime) : "unknown"}
        </span>
        {stale && (
          <span className="data config-drawer-stale-chip" role="status">
            panel built at {shortSha(distSha)}, repo at {shortSha(repoHeadSha)}
          </span>
        )}
      </div>
    </dialog>
  );
}
