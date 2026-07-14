// The one place sapwood shells out to `gh`. SECURITY: execFile with an argv array —
// never exec/shell:true, so issue/board text is always data, never shell input
// (PLAN security model). Every gh call in the engine goes through this.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

/** Run `gh <args...>` and return stdout. Throws on non-zero exit. */
export type GhRunner = (args: string[]) => Promise<string>;

export const gh: GhRunner = async (args) => {
  const { stdout } = await pexecFile("gh", args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
};

/**
 * Run `gh` and return stdout+stderr combined, even on non-zero exit. For diagnostic
 * commands like `gh auth status` that (a) write to stderr and (b) exit non-zero when not
 * logged in — we want the text either way, never a thrown error. Do NOT use for commands
 * whose stdout you parse as JSON (stderr warnings would corrupt it).
 */
export async function ghText(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await pexecFile("gh", args, { maxBuffer: 8 * 1024 * 1024 });
    return stdout + stderr;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return (err.stdout ?? "") + (err.stderr ?? "");
  }
}
