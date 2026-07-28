// The one place sapwood shells out to `gh`. SECURITY: execFile with an argv array —
// never exec/shell:true, so issue/board text is always data, never shell input
// (PLAN security model). Every gh call in the engine goes through this.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

/** Run `gh <args...>` and return stdout. Throws on non-zero exit. */
export type GhRunner = (args: string[]) => Promise<string>;

// #395 (F24 liveness): the live loop (forge.ts's GithubForge) always threads an explicit timeout
// sourced from cfg.liveness.forgeCallTimeoutMs — this constant only backstops callers that use
// the bare `gh`/`ghText` exports without one (init.ts's one-shot `sapwood init` commands, which
// aren't config-threaded and aren't the long-running loop this issue is about).
const DEFAULT_GH_TIMEOUT_MS = 30_000;

/** Run `gh <args...>` and return stdout. Throws on non-zero exit OR when `timeoutMs` elapses —
 *  node's `execFile` `timeout` option kills the child and rejects, so a dead socket / hung
 *  upstream `gh` call fails toward retry instead of wedging the caller forever (#395: the live
 *  incident was a role-session await with no such bound, wedged 30+ minutes after a host sleep
 *  lost the in-flight call's completion). Exported (not just `gh`/`ghText` below) so a
 *  cfg-threaded caller — GithubForge.gh — can pass its own configured bound explicitly; `gh`/
 *  `ghText` keep the narrower 1-arg `GhRunner` shape for every other existing caller. */
export async function ghWithTimeout(args: string[], timeoutMs: number = DEFAULT_GH_TIMEOUT_MS): Promise<string> {
  const { stdout } = await pexecFile("gh", args, { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs });
  return stdout;
}

export const gh: GhRunner = ghWithTimeout;

/**
 * Run `gh` and return stdout+stderr combined, even on non-zero exit. For diagnostic
 * commands like `gh auth status` that (a) write to stderr and (b) exit non-zero when not
 * logged in — we want the text either way, never a thrown error. Do NOT use for commands
 * whose stdout you parse as JSON (stderr warnings would corrupt it).
 *
 * Same #395 timeout bound as ghWithTimeout above (default when the caller doesn't supply one) —
 * a hang here must fail toward "no text" (the catch below already tolerates that), never wedge.
 */
export async function ghText(args: string[], timeoutMs: number = DEFAULT_GH_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout, stderr } = await pexecFile("gh", args, { maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs });
    return stdout + stderr;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return (err.stdout ?? "") + (err.stderr ?? "");
  }
}
