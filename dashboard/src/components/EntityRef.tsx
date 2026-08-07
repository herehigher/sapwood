import type { EntityToken } from "../copy.ts";
import type { EntityTitles } from "../entities.ts";
import { IssueGlyph, PrGlyph } from "./icons.tsx";

/** Renders one issue/PR number as it appears everywhere in scope (lane cards, feed sentences):
 *  a type glyph (never color alone), the number, and a native hover tooltip carrying the title
 *  IF one has been folded for that entity — never a live GitHub call to backfill one (§3 C). */
export function EntityRef({ token, titles, repoUrl }: { token: EntityToken; titles: EntityTitles; repoUrl?: string | undefined }) {
  const known = token.kind === "issue" ? titles[token.number] : token.issue !== undefined ? titles[token.issue] : undefined;
  const title = token.kind === "issue" ? known?.issueTitle : known?.prTitle;
  const glyph = token.kind === "issue" ? <IssueGlyph /> : <PrGlyph />;
  const label = `#${token.number}`;
  const path = token.kind === "issue" ? "issues" : "pull";
  const content = (
    <>
      {glyph}
      {label}
    </>
  );
  if (!repoUrl) {
    return (
      <span className="entity-ref data" title={title}>
        {content}
      </span>
    );
  }
  return (
    <a className="entity-ref data" href={`${repoUrl}/${path}/${token.number}`} target="_blank" rel="noreferrer" title={title}>
      {content}
    </a>
  );
}
