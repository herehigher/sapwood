// bypass-permissions-warning.ts (#1011, DR #1009's C): the owner-ruled disclose-only response to
// `host.permissionMode: bypassPermissions` — that value runs every claude session unchecked
// (including writes to Claude Code's own protected paths) on the OPERATOR's own say-so; the
// engine does not, and structurally cannot, verify whether the operator's own OS-level isolation
// is adequate for that. Same "no startup refusal, no needs-human escalation, no gate — one
// engine-log warning per start" stance as its siblings (managed-permission-warning.ts's #554,
// branch-protection-warning.ts's #633), but log-AND-event like checkWebAccessSettingsDenial
// (cli.ts, #410 amendment): a pure config read needs no fail-open try/catch shape of its own
// (parsing already happened at config load; this function only branches on the resolved enum
// value), but the durable event still matters — the same "queryable from the events ledger, not
// just stderr scrollback" reason #410's own version carries one.
import type { SapwoodConfig } from "../config/config.js";
import type { State } from "../state/state.js";

const warningMessage =
  `[sapwood:startup] host.permissionMode is "bypassPermissions" — every claude session this engine ` +
  `spawns runs WITHOUT a permission prompt or classifier check, including writes to Claude Code's own ` +
  `protected paths. This is an operator call the engine does not gate: whether your own OS-level ` +
  `isolation is adequate is a judgment the engine has no way to verify. Two exits: pair this mode with ` +
  `an outer boundary (a container, a dedicated VM, or @anthropic-ai/sandbox-runtime — see ` +
  `docs/security.md#execution-profiles-host-permission-mode--bash-sandbox's "Operator recipe for an ` +
  `outer boundary" section for the exact recipes), or consciously accept the unbounded posture. No ` +
  `action is taken automatically.`;

/** Run once per engine start (cli.ts, next to checkWebAccessSettingsDenial and the other startup
 *  disclosure checks). A pure config read — never throws on its own — but `state.appendEvent` can
 *  (a SQLite write failure), so the whole body is contained the same way checkWebAccessSettingsDenial's
 *  is: a detection feature must never itself become a new startup-failure mode. Returns whether the
 *  warning fired, mostly for tests — no dispatch gate reads it. */
export function detectBypassPermissionsMode(
  cfg: Pick<SapwoodConfig, "host">,
  state: Pick<State, "appendEvent">,
  log: (message: string) => void = console.error,
): boolean {
  if (cfg.host.permissionMode !== "bypassPermissions") return false;
  try {
    log(warningMessage);
    state.appendEvent("bypass-permissions-mode-configured", { permissionMode: cfg.host.permissionMode });
    return true;
  } catch (error) {
    log(`[sapwood:startup] bypass-permissions-mode-configured event write failed (non-fatal, startup continues): ${String(error)}`);
    return true; // the WARN itself already logged above — only the durable event write failed
  }
}
