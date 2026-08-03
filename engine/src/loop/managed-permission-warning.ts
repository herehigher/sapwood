// managed-permission-warning.ts (#554): the owner-ruled disclose + detect-and-WARN response to
// the codex re-review finding on PR #553 (#534) — a target's managed settings can set
// `allowManagedPermissionRulesOnly: true`, which voids EVERY CLI-argument permission rule this
// engine passes (`--disallowedTools`/`--allowedTools`: the blanket Bash deny, the Write/Edit/
// MultiEdit deny, the Agent/Task spawn deny — see docs/security.md's own exception paragraph).
// Ruling: no startup refusal, no needs-human escalation — just one engine-log warning per start,
// naming both operator exits. Fail-open (no warning, no error) when managed settings are
// absent/unreadable, which is the normal, unmanaged host — zero behavior change there.
import { readFileSync } from "node:fs";

/** The three OS locations Claude Code itself deploys `managed-settings.json` to (Claude Code
 *  docs, "Enterprise managed policy settings" — verified 2026-08-03). Not configurable: these
 *  are the CLI's own fixed paths, not something sapwood chooses. */
export function managedSettingsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

const warningMessage = (path: string): string =>
  `[sapwood:startup] managed settings at ${path} set allowManagedPermissionRulesOnly: true — every ` +
  `CLI-argument permission rule sapwood passes (--disallowedTools/--allowedTools: the blanket Bash ` +
  `deny, the Write/Edit/MultiEdit deny, the Agent/Task spawn deny) is VOID on this host; only ` +
  `managed-settings permission rules are respected. Two exits: mirror sapwood's deny rules into ` +
  `managed settings yourself, or consciously accept this posture. Either way, see ` +
  `docs/security.md#managed-settings-allowmanagedpermissionrulesonly-exception-554 for the exact ` +
  `rule list and both options in full. No action is taken automatically.`;

/** Run once per engine start (cli.ts, next to detectRapidRestart/detectConsecutiveStalls). Never
 *  throws — same non-throwing startup-detector stance as its siblings: absent, unreadable, or
 *  malformed managed settings is the ordinary unmanaged-host case, so it fails open silently
 *  rather than becoming a new startup-failure mode. Returns whether the warning fired, mostly
 *  for tests — no dispatch gate reads it. */
export function detectManagedPermissionMode(
  log: (message: string) => void = (line) => console.error(line),
  opts: { path?: string; readFile?: (path: string) => string } = {},
): boolean {
  const path = opts.path ?? managedSettingsPath();
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  try {
    const parsed = JSON.parse(readFile(path)) as { allowManagedPermissionRulesOnly?: unknown };
    if (parsed.allowManagedPermissionRulesOnly === true) {
      log(warningMessage(path));
      return true;
    }
  } catch {
    // Absent / unreadable / malformed -> fail open (the normal, unmanaged-host case).
  }
  return false;
}
