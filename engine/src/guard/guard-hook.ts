// PreToolUse hook adapter. Wires the pure `guardDecision` to Claude Code's hook protocol:
// reads the hook event JSON on stdin, emits a `permissionDecision: deny` on a BLOCK.
//
// FAIL-CLOSED (PLAN requirement, a divergence from 0day which fails open): any error —
// malformed JSON, an unexpected payload shape, or the guard throwing — yields a DENY, not
// a silent allow. A safety hook that can be disabled by feeding it garbage is not a
// safety hook. The pure mapping (`hookResponse`) is offline-testable; only `main()` does IO.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type GuardInput, guardDecision } from "./guard.js";

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
    // biome-ignore lint/complexity/useLiteralKeys: external hook payload keys intentionally use bracket access.
    const tool = typeof p["tool_name"] === "string" ? p["tool_name"] : "";
    // biome-ignore lint/complexity/useLiteralKeys: external hook payload keys intentionally use bracket access.
    const rawInput = p["tool_input"];
    const inputIsObject = typeof rawInput === "object" && rawInput !== null;
    // For a guarded tool, a missing/non-object tool_input means we can't inspect what it
    // would do → fail closed rather than treat it as an empty (and therefore allowed) call.
    if (GUARDED_TOOLS.has(tool) && !inputIsObject) {
      return deny(`BLOCK [fail-closed] ${tool} with malformed tool_input`);
    }
    const toolInput = (inputIsObject ? rawInput : {}) as GuardInput;
    // biome-ignore lint/complexity/useLiteralKeys: external hook payload keys intentionally use bracket access.
    const cwd = typeof p["cwd"] === "string" ? p["cwd"] : "";
    const decision = guardDecision(tool, toolInput, cwd);
    return decision.allow ? null : deny(decision.reason);
  } catch (e) {
    return deny(`BLOCK [fail-closed] guard error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export type GuardMode = "hard" | "soft";

/**
 * Resolve the enforcement mode from the environment. HARD is the default and the fail-safe:
 * ONLY the exact value "soft" selects observe-mode; anything else (unset, typo, empty) → hard.
 * Sourced from the spawn env set by worker.ts/conductor (trusted) — NOT a worker-writable file
 * — so a worker can't flip its own guard from hard to soft (the self-dogfooding risk).
 */
export function resolveGuardMode(env: Record<string, string | undefined>): GuardMode {
  // biome-ignore lint/complexity/useLiteralKeys: environment key is intentionally bracket-addressed.
  return env["SAPWOOD_GUARD_MODE"] === "soft" ? "soft" : "hard";
}

/**
 * Apply the mode to a raw decision. HARD: pass the deny through (enforce). SOFT: never deny —
 * return allow (null), but surface what WOULD have been blocked via `logged` so observe-mode
 * has a record. An allow decision is unaffected in both modes.
 */
export function applyGuardMode(decision: DenyOutput | null, mode: GuardMode): { output: DenyOutput | null; logged: DenyOutput | null } {
  if (decision === null) return { output: null, logged: null };
  if (mode === "soft") return { output: null, logged: decision };
  return { output: decision, logged: null };
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
  let decision: DenyOutput | null;
  try {
    decision = responseFromText(await readStdin());
  } catch (e) {
    // Even an stdin read failure fails closed.
    decision = deny(`BLOCK [fail-closed] hook IO error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { output, logged } = applyGuardMode(decision, resolveGuardMode(process.env));
  if (logged !== null) {
    // observe-mode: record the would-block to stderr (captured in the worker's hook log).
    process.stderr.write(`[sapwood-guard:soft] would BLOCK: ${logged.hookSpecificOutput.permissionDecisionReason}\n`);
  }
  if (output !== null) process.stdout.write(JSON.stringify(output) + "\n");
  return 0;
}

// Run only when invoked directly (not when imported by tests).
// Compare REALPATHS: `guardSettings` (worker.ts) invokes this hook via `node '<hookPath>'`,
// and that path can itself be reached through a symlink (e.g. a packaged install) — a raw
// string compare of import.meta.url vs argv[1] would then be false (import.meta.url resolves
// the real file, argv[1] stays the symlink), main() would never run, and the hook would
// silently no-op — a fail-OPEN bypass of the safety guard. Same fix/rationale as cli.ts.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then((c) => process.exit(c));
}
