// proxy/mint.ts — #244: the ONE place that turns engine-side config/forge/state into a concrete
// `mint` function of the exact shape peripheral.ts's RoleSessionOpts.proxy and worker.ts's
// WorkerProxyOpts both expect: `(session: {role, session}) => Promise<ForgeProxyHandle>`. Folds
// proxy/access.ts's role x tool matrix in (deny-by-default for an unrecognized role) so every
// caller — a RoleRunner peripheral phase or a WorkerSupervisor worker leg — gets a proxy handle
// already scoped to what ITS role is granted, without re-deriving the matrix lookup itself.
//
// A caller supplies `roundId`/`phase` once (known at its own call site — round-defaults.ts's
// per-phase stub, or whatever wires a worker leg's `proxy` opt); `role`/`session` arrive per
// mint() call from the runner itself (RoleRunner.run()/WorkerSupervisor.dispatch() both pass
// their own generated lane/session name). `attempt` is fixed at 1 here rather than threaded
// through mint()'s narrow parameter shape (session role + name only, no attempt ordinal) —
// harmless: the journal's real per-attempt uniqueness comes from `session` (a fresh, unique
// name every RoleRunner.run()/dispatch() call already generates), not from `attempt`, so two
// attempts of the same phase never collide in the journal regardless of this field's value.
import type { SapwoodConfig } from "../config/config.js";
import type { State } from "../state/state.js";
import { allowedToolsForRole } from "./access.js";
import type { ForgeProxyHandle, ProxyForge } from "./mcp-server.js";
import { startForgeProxyServer } from "./mcp-server.js";

export interface ProxyMintDeps {
  cfg: Pick<SapwoodConfig, "board" | "proxy">;
  forge: ProxyForge;
  state: Pick<
    State,
    | "nextForgeProxySeq"
    | "appendForgeProxyJournalIntent"
    | "recordForgeProxyJournalResponse"
    | "recordForgeProxyJournalError"
    | "markForgeProxyJournalDelivered"
    | "listForgeProxyJournal"
    | "forgeProxyUsage"
    | "forgeProxyBundleDir"
    | "recordForgeProxyBundle"
  >;
  roundId: number;
  phase: string;
  now?: () => Date;
  log?: (message: string) => void;
}

/** Build a `mint` function scoped to one round/phase — pass the result as the RoleSessionOpts.proxy
 *  / WorkerProxyOpts.mint field. Each call mints a FRESH server (a new ephemeral port + bearer
 *  token) — never reused across sessions, same one-server-per-session contract #234 established. */
export function createProxyMint(deps: ProxyMintDeps): (session: { role: string; session: string }) => Promise<ForgeProxyHandle> {
  return async (session) => {
    const proxyCfg = deps.cfg.proxy;
    return startForgeProxyServer({
      forge: deps.forge,
      state: deps.state,
      identity: { roundId: deps.roundId, phase: deps.phase, role: session.role, session: session.session, attempt: 1 },
      scope: { owner: deps.cfg.board.owner, repo: deps.cfg.board.repo },
      caps: { ...proxyCfg.caps },
      budget: { ...proxyCfg.budget },
      timeoutMs: proxyCfg.timeoutMs,
      allowedTools: allowedToolsForRole(session.role),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    });
  };
}
