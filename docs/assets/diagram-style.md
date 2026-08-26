# Diagram style — regeneration guide

The style spec for regenerating sapwood's three diagrams as static images
(e.g. a docs export or social-preview card). The faithful SVG exports are
committed under `docs/assets/`; this file is the regeneration recipe.

## Palette

- GitHub layer — amber `#D9A441`
- Engine layer — slate blue `#4C6EF5`
- Headless sessions layer — teal `#12B886`
- Reviewer adapter layer — violet `#7C3AED`
- Background — `#FAFAFA` (light) / `#1E1E1E` (dark)

## Node shape per layer

- GitHub — rounded rectangle (external system).
- Engine — plain rectangle (deterministic code).
- Headless sessions — rounded rectangle, dashed border (ephemeral process).
- Reviewer adapter — diamond (pluggable choice point).
- Worker-lifecycle states (Diagram 3) — rounded rectangle; the terminal
  `done` state gets a double border.

## Label rules

- Match `README.md`'s node text exactly — the image renders the same
  diagram, it does not redesign it.
- Quote any label containing a comma, parenthesis, or the `·` separator.
- No file paths or module names in labels — concepts only, same "map, not
  manual" rule the source diagrams already follow.
- Keep each diagram's node count at or under 10, matching the Mermaid
  source's own cap.

## Diagram descriptions (source of truth: `docs/assets/*.mmd`)

1. **Hero loop** (`flowchart LR`) — a worker claims a Ready issue, pushes;
   the engine opens the PR, gates it on CI + review, then merges or stops
   for a human.
2. **Layered architecture** (`flowchart TB`) — GitHub holds process truth;
   the engine orchestrates; headless sessions do the work; a pluggable
   adapter reviews it.
3. **Worker lifecycle** (`stateDiagram-v2`) — `done` is terminal; `failed`
   can resume; a soft-budget `handoff` returns to where it started.

## Regeneration recipe

The checked-in `docs/assets/*.mmd` files (Diagrams 1–3) are the semantic
spec — the authoritative set of nodes, edges, and labels. A regenerated
image may re-declare node shapes per this file's rules above; it never
invents a node or edge the Mermaid source doesn't have.

**Faithful export** — a literal, unstyled render straight from the shipped
source, for proofing that an image still matches the diagram:

1. Render with the Mermaid CLI directly against the checked-in `.mmd` file:
   ```
   npx -y @mermaid-js/mermaid-cli@11 -i <diagram>.mmd -o <name>.svg -s 2
   ```
   Verified against `npx -y @mermaid-js/mermaid-cli@11 --help` (mermaid-cli
   11.x): `-s`/`--scale` is the Puppeteer scale factor, and it's what
   actually doubles the output's pixel dimensions for a sharp 2× export.
   `-w`/`--width` sets the rendering page width, not the diagram's own
   size — Mermaid auto-sizes its SVG to the diagram's content regardless of
   page width, so passing `-w` has no effect on these three diagrams and
   should be omitted. At `-s 2` the three shipped diagrams render at
   roughly 1050–1570px on the longer edge; there is no fixed target size to
   pin, since each diagram's pixel size follows its own content layout, not
   a page setting.
2. Save under `docs/assets/`, named for the diagram (`hero-loop.svg`,
   `architecture.svg`, `worker-lifecycle.svg`).

**Styled poster** — a hand-designed image applying this file's palette,
shapes, and label rules (for a docs export or social-preview card), made
with whatever image tool the owner chooses for that piece of work; this
file assumes no specific tool beyond the mermaid-cli export above. Give
whichever tool is used exactly these two inputs, nothing else:

- the relevant `docs/assets/*.mmd` file(s), verbatim, as the node/edge/
  label spec;
- this file's Palette, Node shape per layer, and Label rules sections, as
  the restyling spec.
