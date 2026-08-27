# Diagram style — regeneration guide

The style spec for sapwood's three README diagrams. The committed images
under `docs/assets/` (`hero-loop.svg`, `architecture.svg`,
`worker-lifecycle.svg`) are hand-styled redraws of the checked-in Mermaid
sources next to them (`*.mmd`). The `.mmd` is the semantic spec — the
authoritative set of nodes, edges, and labels; the SVG is a derived
artifact. This file is the recipe for regenerating the SVGs.

## Tokens

- Paper (background) — `#FAFAFA`. The SVG paints it explicitly, so one
  file serves GitHub light, GitHub dark, and npm (npm strips `<picture>`
  and GitHub's `#gh-*-mode-only` fragments are GitHub-only).
- Ink — `#2d3142` (node text, primary strokes). Muted — `#4f5d75`
  (arrows, secondary text). Soft — `#7a8399` (edge labels).
- Accent — `#4C6EF5`, tint `rgba(76,110,245,0.08)`. One focal node and at
  most one focal arrow per diagram: the merge gate (hero loop), the
  conductor (architecture), `done` (lifecycle).
- Layer hues (architecture only) — GitHub amber `#D9A441`, Engine slate
  blue `#4C6EF5`, Headless sessions teal `#12B886`, Reviewer adapter
  violet `#7C3AED`. A hue colors its layer's zone band only (fill at
  6–10% opacity, hairline at 35–55%, eyebrow text in the hue); non-focal
  nodes inside a band keep the ink/white treatment, so the single accent
  (the conductor) still reads.

## Shape per role

- External system (GitHub) — rounded rect, `ink @ 0.03` fill, `ink @ 0.30`
  stroke.
- Engine component — rounded rect (`rx=6`), white fill, ink stroke.
  Store (SQLite state) — `ink @ 0.05` fill, muted stroke.
- Ephemeral (the headless-sessions zone, the `handoff` state) — dashed
  stroke `4,3`. Resume/return edges (`handoff → running`,
  `handoff → fixing`, `failed → driving`) are dashed too; every other edge
  is solid.
- Focal — accent stroke `1.2`, accent-tint fill.
- Terminal — `done` (lifecycle) gets a double border; `Done` (hero loop)
  is a pill (`rx` = half the height). Start (lifecycle) — filled ink dot,
  `r=6`.
- Zones — one band per `.mmd` subgraph, filled with its layer hue (see
  Tokens), uppercase Geist Mono eyebrow in the same hue; the
  headless-sessions band is dashed.

## Label rules

- Node text comes from the `.mmd`. A redraw may break a label over two
  lines or move a `/`-separated list into a mono sublabel; it never
  rewords it.
- Every `.mmd` subgraph is drawn as a zone band carrying its title as the
  eyebrow; a band's single node shows only the node's own text
  (architecture: the Reviewer adapter band holds the adapter list as two
  mono lines).
- Edge labels (guards) — uppercase Geist Mono 8px on an opaque paper mask,
  6–10px off the stroke.
- Every node and edge in the `.mmd` appears in the image; the image never
  invents a node or edge. Drawn-node budget: 9 per diagram.
- Fonts — names in `'Geist','Helvetica Neue',Arial,sans-serif`; sublabels
  and edge labels in `'Geist Mono',Menlo,Consolas,monospace`. The SVG
  carries no font `@import`: GitHub renders README images inside `<img>`,
  which cannot fetch fonts, so the committed file must already look right
  in the fallback face.

## Regeneration recipe

1. Redraw from the source with the `diagram-design` Claude Code plugin
   (marketplace `cathrynlavery/diagram-design`):
   `/diagram-design:import-mermaid docs/assets/<name>.mmd`, detail
   `faithful`, size `fit`, applying the Tokens / Shape / Label sections
   above in place of the plugin's default skin. Export the `<svg>` element
   alone — no font `@import` — to `docs/assets/<name>.svg`.
2. Proof it the way README shows it: load the SVG through `<img src>` on a
   white page and on `#0d1117` (GitHub dark); no label may overflow its
   box in the fallback font.
3. Optional literal render for a node/edge audit:
   `npx -y @mermaid-js/mermaid-cli@11 -i docs/assets/<name>.mmd -o <tmp>.svg`
   draws the `.mmd` as-is (byte-deterministic for a given mermaid-cli
   version) so the styled image can be checked against it. The committed SVG is not
   derived from that render.
