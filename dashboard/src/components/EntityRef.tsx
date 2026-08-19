import type { EntityToken } from "../copy.ts";
import type { EntityTitles } from "../entities.ts";
import { HintTooltip } from "./HintTooltip.tsx";
import { IssueGlyph, PrGlyph } from "./icons.tsx";

/** The folded title for one issue/PR token, if `foldEntityTitles` has captured one yet — the ONE
 *  place this lookup is written, shared by `EntityRef` itself and any future caller that needs
 *  the title as plain text rather than inside this component's own tooltip-wrapped render. */
export function resolveEntityTitle(token: EntityToken, titles: EntityTitles): string | undefined {
  const known = token.kind === "issue" ? titles[token.number] : token.issue !== undefined ? titles[token.issue] : undefined;
  return token.kind === "issue" ? known?.issueTitle : known?.prTitle;
}

/** Renders one issue/PR number as it appears everywhere in scope (lane cards, feed sentences):
 *  a type glyph (never color alone), the number, and a Radix hover/focus tooltip (#892 — replaces
 *  the keyboard/touch-unreachable bare `title=`) carrying the title IF one has been folded for
 *  that entity — never a live GitHub call to backfill one (§3 C). */
export function EntityRef({ token, titles, repoUrl }: { token: EntityToken; titles: EntityTitles; repoUrl?: string | undefined }) {
  const title = resolveEntityTitle(token, titles);
  const glyph = token.kind === "issue" ? <IssueGlyph /> : <PrGlyph />;
  const label = `#${token.number}`;
  const path = token.kind === "issue" ? "issues" : "pull";
  const content = (
    <>
      {glyph}
      {label}
    </>
  );
  const trigger = !repoUrl ? (
    // tabIndex: only when there's a tooltip to reveal — without a repoUrl there's no <a href> to
    // make this focusable by construction, so a folded title needs it added explicitly for Tab to
    // ever reach the trigger (#892 AC1); with no title, HintTooltip skips the wrapper entirely and
    // this would be a meaningless tab stop. The <a> branch below is already focusable either way.
    <span className="entity-ref data" tabIndex={title ? 0 : undefined}>
      {content}
    </span>
  ) : (
    <a className="entity-ref data" href={`${repoUrl}/${path}/${token.number}`} target="_blank" rel="noreferrer">
      {content}
    </a>
  );
  return <HintTooltip content={title}>{trigger}</HintTooltip>;
}
