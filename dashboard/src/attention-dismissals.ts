import { appendFileSync, readFileSync } from "node:fs";

export const ATTENTION_DISMISSALS_FILE = "attention-dismissals.jsonl";

/** Operator-owned dismissals are deliberately independent of the immutable ledger. */
export function readAttentionDismissalIds(path: string | null): number[] {
  if (path === null) return [];
  try {
    const ids = new Set<number>();
    for (const line of readFileSync(path, "utf8").split("\n")) {
      try {
        const parsed = JSON.parse(line) as { eventId?: unknown; kind?: unknown; ts?: unknown };
        if (
          typeof parsed.eventId === "number" &&
          Number.isInteger(parsed.eventId) &&
          parsed.eventId >= 1 &&
          typeof parsed.kind === "string" &&
          parsed.kind.length > 0 &&
          parsed.kind.length <= 100 &&
          typeof parsed.ts === "string"
        ) {
          ids.add(parsed.eventId);
        }
      } catch {
        // A hand-edited or interrupted line must not hide every other valid dismissal.
      }
    }
    return [...ids];
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

export function appendAttentionDismissal(path: string, eventId: number, kind: string, now: Date): void {
  if (readAttentionDismissalIds(path).includes(eventId)) return;
  let separator = "";
  try {
    const existing = readFileSync(path, "utf8");
    if (existing.length > 0 && !existing.endsWith("\n")) separator = "\n";
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  appendFileSync(path, `${separator}${JSON.stringify({ eventId, kind, ts: now.toISOString() })}\n`, "utf8");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
