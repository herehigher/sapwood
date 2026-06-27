// PreToolUse hook adapter. Wires the pure `guardDecision` to Claude Code's hook protocol:
// reads the hook event JSON on stdin, emits a `permissionDecision: deny` on a BLOCK.
//
// FAIL-CLOSED (PLAN requirement, a divergence from 0day which fails open): any error —
// malformed JSON, an unexpected payload shape, or the guard throwing — yields a DENY, not
// a silent allow. A safety hook that can be disabled by feeding it garbage is not a
// safety hook. The pure mapping (`hookResponse`) is offline-testable; only `main()` does IO.
import { guardDecision, type GuardInput } from "./guard.js";

// Tools the guard actually inspects — a malformed tool_input for these fails closed.
const GUARDED_TOOLS = new Set(["Bash", "Write", "Edit", "MultiEdit"]);

export interface DenyOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

const deny = (reason: string): DenyOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

/**
 * Map a parsed hook payload to a deny-output, or null to allow (no intervention).
 * Fail-closed: a non-object payload or a thrown guard error → deny.
 */
export function hookResponse(payload: unknown): DenyOutput | null {
  if (typeof payload !== "object" || payload === null) {
    return deny("BLOCK [fail-closed] malformed hook payload (not an object)");
  }
  try {
    const p = payload as Record<string, unknown>;
    const tool = typeof p["tool_name"] === "string" ? p["tool_name"] : "";
    const rawInput = p["tool_input"];
    const inputIsObject = typeof rawInput === "object" && rawInput !== null;
    // For a guarded tool, a missing/non-object tool_input means we can't inspect what it
    // would do → fail closed rather than treat it as an empty (and therefore allowed) call.
    if (GUARDED_TOOLS.has(tool) && !inputIsObject) {
      return deny(`BLOCK [fail-closed] ${tool} with malformed tool_input`);
    }
    const toolInput = (inputIsObject ? rawInput : {}) as GuardInput;
    const cwd = typeof p["cwd"] === "string" ? p["cwd"] : "";
    const decision = guardDecision(tool, toolInput, cwd);
    return decision.allow ? null : deny(decision.reason);
  } catch (e) {
    return deny(`BLOCK [fail-closed] guard error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Parse hook stdin text and decide. Fail-closed: a JSON parse error → deny. */
export function responseFromText(text: string): DenyOutput | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return deny("BLOCK [fail-closed] unparseable hook input (invalid JSON)");
  }
  return hookResponse(payload);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(): Promise<number> {
  let out: DenyOutput | null;
  try {
    out = responseFromText(await readStdin());
  } catch (e) {
    // Even an stdin read failure fails closed.
    out = deny(`BLOCK [fail-closed] hook IO error: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (out !== null) process.stdout.write(JSON.stringify(out) + "\n");
  return 0;
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c));
}
