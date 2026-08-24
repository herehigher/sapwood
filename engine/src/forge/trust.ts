/** GitHub surfaces bot logins with and without this suffix across its REST and GraphQL APIs. */
export function normalizeLogin(login: string): string {
  return login.replace(/\[bot\]$/, "");
}

/** The reviewer bot identities that retain access to forge-read review evidence. */
export const CODEX_REVIEWER_LOGINS = ["chatgpt-codex-connector"] as const;
